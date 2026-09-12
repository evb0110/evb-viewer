import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';

const browserDocumentStoreMock = vi.hoisted(() => ({
    getSourceRef: vi.fn(),
    getSaveTarget: vi.fn(),
    stat: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    runDocumentMutationWithSource: vi.fn(),
    assignSaveTarget: vi.fn(),
    touchRecentFile: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(),
    acknowledgePhysicalSourceCommit: vi.fn(),
}));

const filePickerMock = vi.hoisted(() => ({
    pickSaveTarget: vi.fn(),
    saveBytesToPickerOrDownload: vi.fn(),
    writeDocumentRefToHandle: vi.fn(),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_MAX_FULL_READ_BYTES: 16 * 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));

vi.mock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
    BrowserFileWriteOutcomeError: class BrowserFileWriteOutcomeError extends Error {
        public readonly externalWriteCommitted = null;
    },
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
            assertPhysicalSourceBaseCurrent: vi.fn(),
            acknowledgePhysicalSourceCommit: browserDocumentStoreMock.acknowledgePhysicalSourceCommit,
        }));
        browserDocumentStoreMock.write.mockResolvedValue(true);
        browserDocumentStoreMock.assignSaveTarget.mockResolvedValue(undefined);
        browserDocumentStoreMock.touchRecentFile.mockResolvedValue(undefined);
        filePickerMock.pickSaveTarget.mockResolvedValue({
            canceled: false,
            fileName: 'source.pdf',
            handle: null,
        });
    });

    it('returns structured success when browser save completes', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockResolvedValue({
            canceled: false,
            fileName: 'saved.pdf',
            handle: null,
        });
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'), () => 'hint'))
            .resolves
            .toEqual({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: null,
            });
    });

    it('advances the source base after a picker save so the next save is not seen as an external edit', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockResolvedValue({
            canceled: false,
            fileName: 'saved.pdf',
            handle: {kind: 'file'},
        });
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'), () => 'hint');

        expect(browserDocumentStoreMock.acknowledgePhysicalSourceCommit).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.assignSaveTarget)
            .toHaveBeenCalledBefore(browserDocumentStoreMock.acknowledgePhysicalSourceCommit);
    });

    it('leaves the source base untouched when the picker is canceled', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockResolvedValue({
            canceled: true,
            fileName: 'saved.pdf',
            handle: null,
        });
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'), () => 'hint');

        expect(browserDocumentStoreMock.acknowledgePhysicalSourceCommit).not.toHaveBeenCalled();
    });

    it('returns user-canceled when the picker is canceled', async () => {
        filePickerMock.pickSaveTarget.mockResolvedValue({
            canceled: true,
            fileName: 'source.pdf',
            handle: null,
        });
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'), () => 'hint'))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'user-canceled',
                externalWriteCommitted: false,
                validation: null,
            });
    });

    it('returns write-failed when the browser write path throws', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockRejectedValue(new Error('disk denied'));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'), () => 'hint'))
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
        filePickerMock.saveBytesToPickerOrDownload.mockResolvedValue({
            canceled: false,
            fileName: 'saved.pdf',
            handle: null,
        });
        browserDocumentStoreMock.assignSaveTarget.mockRejectedValue(new Error('state refresh failed'));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured(requireDocumentRef('browser://documents/working'), () => 'hint'))
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
            () => 'hint',
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
        expect(filePickerMock.saveBytesToPickerOrDownload).not.toHaveBeenCalled();
    });
});
