import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    addRecentFile: vi.fn(async () => undefined),
    allowOpenPath: vi.fn(),
    assertQueuedWorkingCopyMutationPreconditions: vi.fn(async () => undefined),
    ensureWorkingCopyDirectory: vi.fn(async () => true),
    enqueueWorkingCopyMutation: vi.fn(async (_workingPath: string, operation: (value: unknown) => Promise<unknown>) => operation({
        cancelGroup: 'test-cancel-group',
        signal: new AbortController().signal,
    })),
    getWorkingCopyOriginalPath: vi.fn(() => ({originalPath: '/tmp/source.pdf'})),
    optimizePdfToFile: vi.fn(async () => ({
        path: '/tmp/optimized.pdf',
        validation: null,
        preset: 'lossless',
        originalBytes: 100,
        optimizedBytes: 90,
        pageCount: 1,
    })),
    showSaveDialogWithExtension: vi.fn(async () => '/tmp/optimized.pdf'),
    updateRecentFilesMenu: vi.fn(),
}));

vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getWorkingCopyOriginalPath: mocks.getWorkingCopyOriginalPath,
}));
vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({enqueueWorkingCopyMutation: mocks.enqueueWorkingCopyMutation}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({allowOpenPath: mocks.allowOpenPath}));
vi.mock('@electron/file-access/documentMutationGuards', () => ({
    assertQueuedWorkingCopyMutationPreconditions: mocks.assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken: (options?: { expectedDocumentRevisionToken?: string | null } | null) =>
        options?.expectedDocumentRevisionToken?.trim() ?? null,
}));
vi.mock('@electron/recentFiles', () => ({addRecentFile: mocks.addRecentFile}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: mocks.updateRecentFilesMenu}));
vi.mock('@electron/features/documents/main/documentDialogCommon', () => ({showSaveDialogWithExtension: mocks.showSaveDialogWithExtension}));
vi.mock('@electron/features/documents/main/pdfOptimization', () => ({
    normalizePdfOptimizeOptions: (value: {preset: string}) => value,
    optimizePdfToFile: mocks.optimizePdfToFile,
}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));

describe('handleOptimizePdfAsCopy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('asserts queued revision preconditions before optimizing a copy', async () => {
        const { handleOptimizePdfAsCopy } = await import('@electron/features/documents/main/handleOptimizePdfAsCopy');

        await expect(handleOptimizePdfAsCopy(
            {
                parentWindow: null,
                sender: {id: 9},
                senderId: 9,
            } as never,
            '/tmp/work.pdf',
            {preset: 'lossless'},
            'request-1',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-before-optimize')},
        )).resolves.toMatchObject({path: '/tmp/optimized.pdf'});

        expect(mocks.assertQueuedWorkingCopyMutationPreconditions).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            'rev-before-optimize',
        );
        expect(mocks.optimizePdfToFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/optimized.pdf',
            {preset: 'lossless'},
            expect.objectContaining({requestId: 'request-1'}),
        );
    });
});
