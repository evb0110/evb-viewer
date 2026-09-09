import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { resolve } from 'path';
import {
    createPendingResultFileStore,
    findPendingOcrResultFileForPath,
} from '@electron/features/ocr/main/createPendingResultFileStore';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const OCR_JOB_ID = requireJobId('42:ocr-1');
const OCR_REQUEST_ID = requireRequestId('ocr-1');
const OCR_DOCUMENT_REF = requireDocumentRef('/tmp/source.pdf');
const OCR_DOCUMENT_REVISION = requireDocumentRevisionToken('source-revision');

describe('createPendingResultFileStore', () => {
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    const removeResultFile = vi.fn(async () => true);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not track result files that do not require cleanup acknowledgement', () => {
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 60_000,
            removeResultFile,
        });

        store.track(OCR_JOB_ID, OCR_REQUEST_ID, 42, OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION, '/tmp/ocr-1.pdf', 'sha256-ocr-1', false);

        expect(store.find(42, OCR_REQUEST_ID)).toBeNull();
        expect(findPendingOcrResultFileForPath(42, '/tmp/ocr-1.pdf')).toBeNull();
        expect(removeResultFile).not.toHaveBeenCalled();
    });

    it('keeps ownership and reports failure when acknowledgement cannot delete the file', async () => {
        removeResultFile
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 60_000,
            removeResultFile,
        });

        store.track(OCR_JOB_ID, OCR_REQUEST_ID, 42, OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION, '/tmp/ocr-1.pdf', 'sha256-ocr-1', true);

        await expect(store.acknowledge(42, OCR_REQUEST_ID, '/tmp/ocr-1.pdf')).resolves.toEqual({
            cleaned: false,
            error: 'Failed to delete pending OCR result file',
        });
        expect(store.find(42, OCR_REQUEST_ID)).not.toBeNull();
        expect(store.find(42, OCR_REQUEST_ID)?.resultSha256).toBe('sha256-ocr-1');
        expect(findPendingOcrResultFileForPath(42, '/tmp/ocr-1.pdf')).not.toBeNull();

        await expect(store.acknowledge(42, OCR_REQUEST_ID, '/tmp/ocr-1.pdf')).resolves.toEqual({ cleaned: true });
        expect(store.find(42, OCR_REQUEST_ID)).toBeNull();
        expect(findPendingOcrResultFileForPath(42, '/tmp/ocr-1.pdf')).toBeNull();
    });

    it('matches owned OCR results across macOS /var and /private/var path aliases', async () => {
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 60_000,
            removeResultFile,
            canonicalizePath: (filePath: string) => filePath.startsWith('/var/folders/')
                ? filePath.replace('/var/folders/', '/private/var/folders/')
                : filePath,
        });
        const rendererPath = '/var/folders/app/T/evb-viewer/ocr-1-merged.pdf';
        const canonicalPath = resolve('/private/var/folders/app/T/evb-viewer/ocr-1-merged.pdf');

        store.track(OCR_JOB_ID, OCR_REQUEST_ID, 42, OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION, rendererPath, 'sha256-alias-result', true);

        expect(store.find(42, OCR_REQUEST_ID)?.pdfPath).toBe(canonicalPath);
        expect(findPendingOcrResultFileForPath(42, rendererPath)?.pdfPath).toBe(canonicalPath);
        expect(findPendingOcrResultFileForPath(42, canonicalPath)?.pdfPath).toBe(canonicalPath);

        await expect(store.acknowledge(42, OCR_REQUEST_ID, rendererPath)).resolves.toEqual({ cleaned: true });
        expect(removeResultFile).toHaveBeenCalledWith(canonicalPath);
        expect(store.find(42, OCR_REQUEST_ID)).toBeNull();
    });

    it('does not delete a newer pending result when stale cleanup finishes late', async () => {
        const removeResolver: {current: ((removed: boolean) => void) | null} = {current: null};
        removeResultFile.mockImplementationOnce(() => new Promise<boolean>((resolveRemoveFile) => {
            removeResolver.current = resolveRemoveFile;
        }));
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 100,
            removeResultFile,
        });

        store.track(OCR_JOB_ID, OCR_REQUEST_ID, 42, OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION, '/tmp/ocr-old.pdf', 'sha256-old', true);
        const evictionPromise = store.evictStale(Date.now() + 1_000);
        await vi.waitFor(() => {
            expect(removeResultFile).toHaveBeenCalledWith(resolve('/tmp/ocr-old.pdf'));
        });

        store.track(OCR_JOB_ID, OCR_REQUEST_ID, 42, OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION, '/tmp/ocr-new.pdf', 'sha256-new', true);
        if (!removeResolver.current) {
            throw new Error('removeResultFile promise was not created');
        }
        removeResolver.current(true);
        await evictionPromise;

        expect(store.find(42, OCR_REQUEST_ID)?.pdfPath).toBe(resolve('/tmp/ocr-new.pdf'));
        expect(store.find(42, OCR_REQUEST_ID)?.resultSha256).toBe('sha256-new');
    });

    it('claims by document scope and revision, preserving the result across sender cleanup', async () => {
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 60_000,
            removeResultFile,
        });
        store.track(
            OCR_JOB_ID,
            OCR_REQUEST_ID,
            42,
            OCR_DOCUMENT_REF,
            OCR_DOCUMENT_REVISION,
            '/tmp/ocr-1.pdf',
            'sha256-ocr-1',
            true,
        );

        expect(store.claimForDocument(43, '/tmp/ocr-1.pdf', OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION)).toMatchObject({status: 'claimed'});
        expect(store.claimForDocument(44, '/tmp/ocr-1.pdf', OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION)).toMatchObject({status: 'already-claimed'});
        await store.cleanupForSender(42);
        expect(store.find(43, OCR_REQUEST_ID)?.claimedByWebContentsId).toBe(43);
        expect(removeResultFile).not.toHaveBeenCalled();

        store.releaseClaim(43, OCR_REQUEST_ID);
        expect(store.claimForDocument(44, '/tmp/ocr-1.pdf', OCR_DOCUMENT_REF, OCR_DOCUMENT_REVISION).status).toBe('claimed');
    });

    it('rejects a claim for a different document revision or scope', () => {
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 60_000,
            removeResultFile,
        });
        store.track(
            OCR_JOB_ID,
            OCR_REQUEST_ID,
            42,
            OCR_DOCUMENT_REF,
            OCR_DOCUMENT_REVISION,
            '/tmp/ocr-1.pdf',
            'sha256-ocr-1',
            true,
        );

        expect(store.claimForDocument(43, '/tmp/ocr-1.pdf', OCR_DOCUMENT_REF, requireDocumentRevisionToken('changed-revision')).status).toBe('not-found');
        expect(store.claimForDocument(43, '/tmp/ocr-1.pdf', requireDocumentRef('/tmp/other.pdf'), OCR_DOCUMENT_REVISION).status).toBe('not-found');
    });

    it('allows a document-scoped owner to explicitly discard an unclaimed result', async () => {
        const store = createPendingResultFileStore({
            logger,
            ttlMs: 60_000,
            removeResultFile,
        });
        store.track(
            OCR_JOB_ID,
            OCR_REQUEST_ID,
            42,
            OCR_DOCUMENT_REF,
            OCR_DOCUMENT_REVISION,
            '/tmp/ocr-1.pdf',
            'sha256-ocr-1',
            true,
        );

        await expect(store.acknowledge(
            43,
            OCR_REQUEST_ID,
            '/tmp/ocr-1.pdf',
            OCR_DOCUMENT_REF,
            OCR_DOCUMENT_REVISION,
        )).resolves.toEqual({cleaned: true});
        expect(store.find(42, OCR_REQUEST_ID)).toBeNull();
    });
});
