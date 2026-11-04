import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    createFileSystemFileHandle,
    FakeLockManager,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import type * as BrowserFilePickerAdapter from '@app/platform/browser-api/browserFilePickerAdapter';
import type * as BrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';

const browserDocumentStoreMock = vi.hoisted(() => ({
    getSourceRef: vi.fn(),
    getSaveTarget: vi.fn(),
    stat: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
    write: vi.fn(),
    runDocumentMutationWithSource: vi.fn(),
    assignSaveTarget: vi.fn(),
    touchRecentFile: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(),
    acknowledgePhysicalSourceCommit: vi.fn(),
}));

const filePickerMock = vi.hoisted(() => ({
    downloadBrowserDocument: vi.fn(),
    ensureFileHandleWritePermission: vi.fn(),
    pickSaveTarget: vi.fn(),
    saveBytesToPickerOrDownload: vi.fn(),
    writeDocumentRefToHandle: vi.fn(),
}));

const qpdfMock = vi.hoisted(() => ({runBrowserQpdfCommand: vi.fn()}));

vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async importOriginal => ({
    ...await importOriginal<typeof BrowserQpdfEngineClient>(),
    runBrowserQpdfCommand: (...args: unknown[]) => qpdfMock.runBrowserQpdfCommand(...args),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_MAX_FULL_READ_BYTES: 16 * 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));

vi.mock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
    BrowserFileWriteOutcomeError: class BrowserFileWriteOutcomeError extends Error {
        public readonly externalWriteCommitted = null;
    },
    downloadBrowserDocument: (...args: unknown[]) => filePickerMock.downloadBrowserDocument(...args),
    ensureFileHandleWritePermission: (...args: unknown[]) => filePickerMock.ensureFileHandleWritePermission(...args),
    pickSaveTarget: (...args: unknown[]) => filePickerMock.pickSaveTarget(...args),
    saveBytesToPickerOrDownload: (...args: unknown[]) => filePickerMock.saveBytesToPickerOrDownload(...args),
    writeDocumentRefToHandle: (...args: unknown[]) => filePickerMock.writeDocumentRefToHandle(...args),
}));

describe('browserSaveTargets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserDocumentStoreMock.getSourceRef.mockResolvedValue('browser://documents/source');
        browserDocumentStoreMock.getSaveTarget.mockResolvedValue({
            saveName: 'source.pdf',
            saveKind: 'pdf',
            saveHandle: null,
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.read.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.runDocumentMutationWithSource.mockImplementation((
            _path: string,
            _sourceRef: string,
            _revision: string | null | undefined,
            operation: (mutation: unknown) => Promise<unknown>,
        ) => operation({
            writeSource: browserDocumentStoreMock.write,
            writeSourceFromDocument: browserDocumentStoreMock.write,
            assertPhysicalSourceBaseCurrent: vi.fn(),
            acknowledgePhysicalSourceCommit: browserDocumentStoreMock.acknowledgePhysicalSourceCommit,
        }));
        browserDocumentStoreMock.write.mockResolvedValue(true);
        browserDocumentStoreMock.assignSaveTarget.mockResolvedValue(undefined);
        browserDocumentStoreMock.touchRecentFile.mockResolvedValue(undefined);
        filePickerMock.ensureFileHandleWritePermission.mockResolvedValue(undefined);
        filePickerMock.pickSaveTarget.mockResolvedValue({
            canceled: false,
            fileName: 'source.pdf',
            handle: null,
        });
    });

    it('returns structured success when browser save completes', async () => {
        filePickerMock.downloadBrowserDocument.mockResolvedValue(undefined);
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working')))
            .resolves
            .toEqual({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: null,
            });
    });

    it('records a stored handle save under its physical name rather than a stale saveName', async () => {
        const handle = createFileSystemFileHandle({name: ' report.PDF'});
        browserDocumentStoreMock.getSaveTarget.mockResolvedValue({
            saveName: 'old.pdf',
            saveKind: 'pdf',
            saveHandle: handle,
        });
        const {saveWorkingBytesToSourceStructured} = await import('@app/platform/browser-api/browserSaveTargets');
        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'))).resolves.toMatchObject({ok: true});
        expect(browserDocumentStoreMock.replaceWithHandleBackedDocument).toHaveBeenCalledWith('browser://documents/source', expect.objectContaining({
            saveName: handle.name,
            saveHandle: handle,
        }));
        expect(browserDocumentStoreMock.assignSaveTarget).toHaveBeenCalledWith('browser://documents/source', handle.name, 'pdf', handle);
    });

    it('advances the source base after a download save so the next save is not seen as an external edit', async () => {
        filePickerMock.downloadBrowserDocument.mockResolvedValue(undefined);
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'));

        expect(browserDocumentStoreMock.acknowledgePhysicalSourceCommit).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.assignSaveTarget)
            .toHaveBeenCalledBefore(browserDocumentStoreMock.acknowledgePhysicalSourceCommit);
    });

    it('returns user-canceled when the picker is canceled', async () => {
        filePickerMock.pickSaveTarget.mockResolvedValue({
            canceled: true,
            fileName: 'source.pdf',
            handle: null,
        });
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working')))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'user-canceled',
                externalWriteCommitted: false,
                validation: null,
            });
    });

    it('stops a stored handle save at a denied write permission before the save lock', async () => {
        browserDocumentStoreMock.getSaveTarget.mockResolvedValue({
            saveName: 'source.pdf',
            saveKind: 'pdf',
            saveHandle: {kind: 'file'},
        });
        filePickerMock.ensureFileHandleWritePermission.mockRejectedValueOnce(new Error('write permission denied'));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working')))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                message: 'write permission denied',
                externalWriteCommitted: false,
            });
        expect(browserDocumentStoreMock.runDocumentMutationWithSource).not.toHaveBeenCalled();
    });

    it('returns write-failed when the browser write path throws', async () => {
        filePickerMock.downloadBrowserDocument.mockRejectedValue(new Error('disk denied'));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working')))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                message: 'disk denied',
                externalWriteCommitted: false,
                validation: null,
            });
    });

    it('reports sync-required when browser bookkeeping fails after the external save commits', async () => {
        filePickerMock.downloadBrowserDocument.mockResolvedValue(undefined);
        browserDocumentStoreMock.assignSaveTarget.mockRejectedValue(new Error('state refresh failed'));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working')))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'working-copy-sync-required',
                externalWriteCommitted: true,
                workingCopySyncRequired: true,
                validation: null,
            });
    });

    it('revalidates the working-copy revision after the picker before external commit', async () => {
        let resolvePicker!: (value: {
            canceled: false;
            fileName: string;
            handle: null;
        }) => void;
        filePickerMock.pickSaveTarget.mockReturnValue(new Promise(resolve => {
            resolvePicker = resolve;
        }));
        browserDocumentStoreMock.runDocumentMutationWithSource.mockRejectedValue(
            new Error('Document changed while this edit was being prepared'),
        );
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        const savePromise = saveWorkingBytesToSourceStructured(
            requireDocumentRef('browser://documents/working'),
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-picker')},
        );
        expect(browserDocumentStoreMock.runDocumentMutationWithSource).not.toHaveBeenCalled();

        resolvePicker({
            canceled: false,
            fileName: 'saved.pdf',
            handle: null,
        });

        await expect(savePromise).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            externalWriteCommitted: false,
        });
        expect(browserDocumentStoreMock.runDocumentMutationWithSource).toHaveBeenCalledWith(
            'browser://documents/working',
            'browser://documents/source',
            'revision-before-picker',
            expect.any(Function),
        );
        expect(filePickerMock.downloadBrowserDocument).not.toHaveBeenCalled();
    });

    it('does not prompt for a revoked write permission while holding the physical-save lock', async () => {
        const actualAdapter = await vi.importActual<typeof BrowserFilePickerAdapter>(
            '@app/platform/browser-api/browserFilePickerAdapter',
        );
        filePickerMock.ensureFileHandleWritePermission.mockImplementation(actualAdapter.ensureFileHandleWritePermission);
        filePickerMock.writeDocumentRefToHandle.mockImplementation(actualAdapter.writeDocumentRefToHandle);
        browserDocumentStoreMock.readRange.mockResolvedValue(Uint8Array.of(1, 2, 3));
        const locks = new FakeLockManager();
        const lockNamesAtPrompt: string[] = [];
        let permissionQueries = 0;
        // Granted when the preflight asks; revoked by the time the save is inside the lock.
        const handle = Object.assign(createFileSystemFileHandle({name: 'source.pdf'}), {
            queryPermission: async () => (++permissionQueries === 1 ? 'granted' : 'prompt'),
            requestPermission: async () => {
                lockNamesAtPrompt.push(...(await locks.query()).held.map(lock => lock.name));
                return 'granted';
            },
        });
        browserDocumentStoreMock.getSaveTarget.mockResolvedValue({
            saveName: 'source.pdf',
            saveKind: 'pdf',
            saveHandle: handle,
        });
        browserDocumentStoreMock.runDocumentMutationWithSource.mockImplementation((
            _path: string,
            _sourceRef: string,
            _revision: string | null | undefined,
            operation: (mutation: unknown) => Promise<unknown>,
        ) => locks.request('evb-viewer:browser-physical-save', {}, () => operation({
            writeSource: browserDocumentStoreMock.write,
            writeSourceFromDocument: browserDocumentStoreMock.write,
            assertPhysicalSourceBaseCurrent: vi.fn(),
            acknowledgePhysicalSourceCommit: browserDocumentStoreMock.acknowledgePhysicalSourceCommit,
        })));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        let result: unknown;
        try {
            result = await saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'));
        } finally {
            filePickerMock.ensureFileHandleWritePermission.mockResolvedValue(undefined);
            filePickerMock.writeDocumentRefToHandle.mockReset();
        }

        expect(lockNamesAtPrompt).not.toContain('evb-viewer:browser-physical-save');
        expect(result).toMatchObject({
            ok: false,
            reason: 'write-failed',
            externalWriteCommitted: false,
        });
        expect((await locks.query()).held).toEqual([]);
    });
});

describe('finishBrowserPdfCandidate', () => {
    const source = Uint8Array.from({length: 10}, (_, index) => index + 1);
    const rewriteResult = (output: Uint8Array | null, exitCode = 0) => ({
        exitCode,
        stdout: '',
        stderr: '',
        output,
    });
    const checkResult = (exitCode: number) => ({
        exitCode,
        stdout: exitCode === 2 ? '' : 'checking document.pdf\nNo syntax or stream encoding errors found',
        stderr: exitCode === 2 ? 'damaged' : '',
        output: null,
    });

    function answerQpdf(rewrite: unknown, checkExitCode = 0) {
        qpdfMock.runBrowserQpdfCommand.mockImplementation(async (command: string) => {
            if (command === 'lossless-rewrite') {
                if (rewrite instanceof Error) throw rewrite;
                return rewrite;
            }
            return checkResult(checkExitCode);
        });
    }

    beforeEach(() => {
        qpdfMock.runBrowserQpdfCommand.mockReset();
    });

    it('keeps a smaller rewrite that passes its own full check and leaves the input intact', async () => {
        const candidate = Uint8Array.of(9, 9, 9);
        answerQpdf(rewriteResult(candidate, 3));
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {fileName: 'kept.pdf'})).resolves.toBe(candidate);

        const rewriteInput = qpdfMock.runBrowserQpdfCommand.mock.calls[0]?.[1] as Uint8Array;
        expect(rewriteInput).not.toBe(source);
        expect(rewriteInput.buffer).not.toBe(source.buffer);
        expect([...source]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
        ]);
        expect(qpdfMock.runBrowserQpdfCommand.mock.calls.map(([command]) => command))
            .toEqual([
                'lossless-rewrite',
                'check',
            ]);
    });

    it.each([
        [
            'an equal-size rewrite',
            rewriteResult(new Uint8Array(10)),
            0,
        ],
        [
            'a larger rewrite',
            rewriteResult(new Uint8Array(11)),
            0,
        ],
        [
            'an empty rewrite',
            rewriteResult(new Uint8Array()),
            0,
        ],
        [
            'no rewrite output',
            rewriteResult(null),
            0,
        ],
        [
            'a failed rewrite exit',
            rewriteResult(Uint8Array.of(1), 2),
            0,
        ],
        [
            'a rewrite that throws',
            new Error('engine ran out of memory'),
            0,
        ],
        [
            'a candidate that fails its full check',
            rewriteResult(Uint8Array.of(1)),
            2,
        ],
    ])('retains the input after %s', async (_label, rewrite, checkExitCode) => {
        answerQpdf(rewrite, checkExitCode);
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {fileName: 'kept.pdf'})).resolves.toBeNull();
    });

    it('throws an abort instead of retaining the input', async () => {
        const controller = new AbortController();
        qpdfMock.runBrowserQpdfCommand.mockImplementation(async () => {
            controller.abort(new DOMException('Optimize was canceled', 'AbortError'));
            throw new Error('engine stopped');
        });
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {
            fileName: 'kept.pdf',
            signal: controller.signal,
        }))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('does not start qpdf after an abort', async () => {
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {
            fileName: 'kept.pdf',
            signal: AbortSignal.abort(),
        }))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(qpdfMock.runBrowserQpdfCommand).not.toHaveBeenCalled();
    });
});
