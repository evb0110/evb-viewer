import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';

const invalidationMocks = vi.hoisted(() => ({
    cancelOcrJobsForWorkingCopy: vi.fn(),
    cancelRequestsForPdfPath: vi.fn(),
    recoverPreparedOcrRevisionTransition: vi.fn(),
}));

let tempRoot = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tempRoot) } }));

vi.mock('@electron/features/ocr/public/index', () => ({cancelOcrJobsForWorkingCopy: invalidationMocks.cancelOcrJobsForWorkingCopy}));

vi.mock('@electron/features/ocr/public/recovery', () => ({recoverPreparedOcrRevisionTransition: invalidationMocks.recoverPreparedOcrRevisionTransition}));

vi.mock('@electron/features/search/main/ipc', () => ({searchWorkerService: {cancelRequestsForPdfPath: invalidationMocks.cancelRequestsForPdfPath}}));

describe('registerDocumentRevisionInvalidationEffects', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-document-revision-effects-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('cancels OCR and search work when a working-copy revision changes', async () => {
        const originalPath = join(tempRoot, 'original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-effects', 'original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            ensureWorkingCopyRevision,
            isWorkingCopyRevisionCurrent,
            markWorkingCopyContentChanged,
        } = await import('@electron/file-access/documentRevisionStore');
        const { registerDocumentRevisionInvalidationEffects } =
            await import('@electron/features/documents/main/registerDocumentRevisionInvalidationEffects');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 9);

        registerDocumentRevisionInvalidationEffects();
        registerDocumentRevisionInvalidationEffects();
        const revision = await ensureWorkingCopyRevision(workingPath, 9);

        await markWorkingCopyContentChanged(workingPath, 'write', 9);

        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
        expect(invalidationMocks.cancelOcrJobsForWorkingCopy).toHaveBeenCalledTimes(1);
        expect(invalidationMocks.cancelOcrJobsForWorkingCopy)
            .toHaveBeenCalledWith(workingPath, 'Document revision changed: write');
        expect(invalidationMocks.cancelRequestsForPdfPath).toHaveBeenCalledTimes(1);
        expect(invalidationMocks.cancelRequestsForPdfPath)
            .toHaveBeenCalledWith(workingPath, 'Document revision changed: write');
    });
});
