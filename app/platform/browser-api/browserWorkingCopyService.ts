import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {
    ensurePdfExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
import { buildBrowserByteLimitError } from '@app/platform/browser-api/browserPlatformHelpers';
import {
    emitBatchOpenProgress,
    type IBrowserBatchOpenProgressOptions,
} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    containsPdfEncryptMarker,
    PDF_ENCRYPT_SCAN_REGION_BYTES,
} from '@pdf-core';
import {
    isPdfDecryptPassword,
    PDF_DECRYPT_PASSWORD_MAX_BYTES,
} from '@contracts/pdfDecryptSchemas';
import {
    isBrowserPageOpsWasmFailure,
    tryRunBrowserPageOpsWithWasm,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';

function buildBrowserLargeJobError(label: string, maxBytes: number, hint?: string) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
        hint,
    );
}

export async function decryptBrowserWorkingCopy(workingPath: string, password?: string) {
    if (password !== undefined && !isPdfDecryptPassword(password)) {
        throw new Error(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
    }
    const { size } = await browserDocumentStore.stat(workingPath);
    const head = await browserDocumentStore.readRange(
        workingPath,
        0,
        Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size),
    );
    let encrypted = containsPdfEncryptMarker(head);
    if (!encrypted && size > head.byteLength) {
        const tailStart = Math.max(
            head.byteLength,
            size - PDF_ENCRYPT_SCAN_REGION_BYTES,
        );
        const tail = await browserDocumentStore.readRange(
            workingPath,
            tailStart,
            size - tailStart,
        );
        encrypted = containsPdfEncryptMarker(tail);
    }
    if (!encrypted) {
        return {
            outcome: 'plain',
            wasEncrypted: false,
        } as const;
    }

    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        throw buildBrowserLargeJobError(
            'Opening encrypted documents',
            BROWSER_MAX_FULL_READ_BYTES,
        );
    }

    const bytes = await browserDocumentStore.read(workingPath);
    const result = await tryRunBrowserPageOpsWithWasm('decrypt', {
        data: bytes,
        password: password ?? '',
    });
    if (result === null) {
        throw new Error('Browser PDF decrypt operation is unavailable');
    }
    if (isBrowserPageOpsWasmFailure(result)) {
        if (result.error.code === 'needs-password') {
            return {
                outcome: 'needs-password',
                wasEncrypted: true,
            } as const;
        }
        if (result.error.code === 'unsupported-filter' || result.error.code === 'encrypted') {
            return {
                outcome: 'unsupported',
                wasEncrypted: true,
            } as const;
        }
        throw new Error(result.error.message);
    }
    if (!(result && result.data instanceof Uint8Array)) {
        throw new Error('Browser PDF decrypt operation returned an invalid result');
    }
    const revision = await browserDocumentStore.getDocumentRevision(workingPath);
    await browserDocumentStore.write(workingPath, new Uint8Array(result.data), {expectedDocumentRevisionToken: revision.token});
    return {
        outcome: 'decrypted',
        wasEncrypted: true,
    } as const;
}

type TBrowserWorkingCopyDecryptionResult = Awaited<ReturnType<typeof decryptBrowserWorkingCopy>>;

export function assertBrowserWorkingCopyDecrypted(
    result: TBrowserWorkingCopyDecryptionResult,
) {
    if (result.outcome === 'needs-password') {
        throw new Error('PDF decryption requires a password');
    }
    if (result.outcome === 'unsupported') {
        throw new Error('PDF encryption handler is unsupported');
    }
}

export async function createBrowserWorkingCopyFromBytes(options: {
    fileName: string;
    data: Uint8Array;
    mimeType?: string;
    sourceRef?: TDocumentRef;
    password?: string;
}) {
    const workingPath = await browserDocumentStore.createStoredDocument(
        options.fileName,
        options.data,
        {
            mimeType: options.mimeType ?? 'application/pdf',
            saveKind: 'pdf',
            kind: 'working',
            ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
        },
    );

    try {
        const decryption = await decryptBrowserWorkingCopy(workingPath, options.password);
        assertBrowserWorkingCopyDecrypted(decryption);
        return workingPath;
    } catch (error) {
        await browserDocumentStore.remove(workingPath).catch(() => undefined);
        throw error;
    }
}

export async function openDocumentPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
    password?: string,
    largeDocumentMessage?: string,
) {
    const startedAt = Date.now();
    const normalizedPaths = normalizeNonEmptyStringPaths(paths);

    if (normalizedPaths.length === 0) {
        return null;
    }

    const firstPath = normalizedPaths[0]!;
    const firstFileName = getBrowserDocumentFileName(firstPath);
    const djvuPaths = normalizedPaths.filter((path) =>
        isDjvuFileName(getBrowserDocumentFileName(path)),
    );

    if (djvuPaths.length > 0) {
        if (normalizedPaths.length === 1 && djvuPaths.length === 1) {
            await browserDocumentStore.touchRecentFile(firstPath);
            emitBatchOpenProgress(progressOptions, 1, 1, startedAt);
            return {
                kind: 'djvu',
                workingPath: '',
                originalPath: firstPath,
            } satisfies TOpenFileResult;
        }
    }

    if (normalizedPaths.length === 1 && isPdfFileName(firstFileName)) {
        const sourcePath = normalizedPaths[0]!;
        const { size } = await browserDocumentStore.stat(sourcePath);
        if (size > BROWSER_MAX_FULL_READ_BYTES) {
            throw buildBrowserLargeJobError(
                'Opening documents',
                BROWSER_MAX_FULL_READ_BYTES,
                largeDocumentMessage ? `. ${largeDocumentMessage}` : undefined,
            );
        }
        if (size <= BROWSER_MAX_FULL_READ_BYTES) {
            await browserDocumentStore.ensureByteBackedSource(sourcePath);
        }
        const workingPath = await browserDocumentStore.cloneAsWorkingCopy(sourcePath);
        let published = false;
        try {
            const decryption = await decryptBrowserWorkingCopy(workingPath, password);
            if (decryption.outcome === 'needs-password') {
                return {
                    kind: 'pdf-needs-password',
                    originalPath: sourcePath,
                } satisfies TOpenFileResult;
            }
            if (decryption.outcome === 'unsupported') {
                return {
                    kind: 'pdf-unsupported-encryption',
                    originalPath: sourcePath,
                } satisfies TOpenFileResult;
            }
            await browserDocumentStore.touchRecentFile(sourcePath);
            browserDocumentStore.unload(sourcePath);
            emitBatchOpenProgress(progressOptions, 1, 1, startedAt);
            published = true;
            return {
                kind: 'pdf',
                workingPath,
                originalPath: sourcePath,
                ...(decryption.wasEncrypted ? {wasEncrypted: true as const} : {}),
            } satisfies TOpenFileResult;
        } finally {
            if (!published) {
                await browserDocumentStore.remove(workingPath).catch(() => undefined);
            }
        }
    }

    const { createCombinedPdfFromPaths } = await import('@app/platform/browser-api/createCombinedPdfFromPaths');
    const combinedPdf = await createCombinedPdfFromPaths(
        normalizedPaths,
        progressOptions,
    );
    const generatedName =
        normalizedPaths.length === 1
            ? ensurePdfExtension(firstFileName.replace(/\.[^.]+$/u, ''))
            : ensurePdfExtension(`combined-${Date.now()}`);
    const originalPath = await browserDocumentStore.createStoredDocument(
        generatedName,
        combinedPdf,
        {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'source',
            retention: 'transient',
        },
    );
    const workingPath =
        await browserDocumentStore.cloneAsWorkingCopy(originalPath);
    browserDocumentStore.unload(originalPath);

    return {
        kind: 'pdf',
        workingPath,
        originalPath,
        isGenerated: true,
    } satisfies TOpenFileResult;
}
