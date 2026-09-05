import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    FakeIndexedDbFactory,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';

const wasmRun = vi.hoisted(() => vi.fn());

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

async function loadService() {
    vi.resetModules();
    const [
        {browserDocumentStore},
        service,
    ] = await Promise.all([
        import('@app/platform/browserDocumentStore'),
        import('@app/platform/browser-api/browserWorkingCopyService'),
    ]);
    return {
        browserDocumentStore,
        ...service,
    };
}

describe('browser working-copy decryption', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
        wasmRun.mockReset();
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
        });
        await expect(browserDocumentStore.read(workingPath)).resolves.toEqual(DECRYPTED_PDF);
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

    it('rejects encrypted browser inputs above the full-read cap before loading them', async () => {
        const {
            browserDocumentStore,
            decryptBrowserWorkingCopy,
        } = await loadService();
        const oversizedPdf = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedPdf.set(
            Uint8Array.from(new TextEncoder().encode('%PDF-1.7\n/Encrypt')),
        );
        const workingPath = await browserDocumentStore.createStoredDocument(
            'large.pdf',
            oversizedPdf,
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        const read = vi.spyOn(browserDocumentStore, 'read');

        await expect(decryptBrowserWorkingCopy(workingPath))
            .rejects.toThrow('Opening encrypted documents is unavailable in the browser');
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
});
