import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { normalizeNonEmptyStringPaths } from '@contracts/shared';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {
    ensurePdfExtension,
    isDjvuFileName,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
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
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {
    isBrowserQpdfEngineUnavailableError,
    normalizeBrowserPdfAppendBase,
} from '@app/platform/browser-api/browserQpdfEngineClient';
import {
    BROWSER_QPDF_ENGINE_ERROR_CODES,
    BROWSER_QPDF_MAX_INPUT_BYTES,
} from '@contracts/browserQpdfEngine';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import {SerializableError} from '@contracts/serializableError';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getErrorMessage} from '@app/utils/error';

async function touchRecentFileForOpen(ref: TDocumentRef) {
    await browserDocumentStore.touchRecentFile(ref);
}

export async function decryptBrowserWorkingCopy(workingPath: string, password?: string, signal?: AbortSignal) {
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

    const revision = await browserDocumentStore.getDocumentRevision(workingPath);
    const bytes = await browserDocumentStore.read(workingPath, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_HEADER.bytes - new TextEncoder().encode(password ?? '').byteLength});
    const result = await runBrowserPageOpsWorkerRequest('decrypt', {
        data: bytes,
        password: password ?? '',
    }, signal ? {signal} : {});
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
    signal?.throwIfAborted();
    await browserDocumentStore.write(workingPath, new Uint8Array(result.data), {expectedDocumentRevisionToken: revision.token});
    return {
        outcome: 'decrypted',
        wasEncrypted: true,
    } as const;
}

/**
 * Desktop's `normalizePdfAppendBase` for the working copy of a PDF being
 * opened; snapshots of an open document keep its bytes, as on desktop. A PDF
 * whose cross-reference chain an edit cannot extend is rewritten through qpdf
 * before anything reads it, so every object number the viewer later captures
 * belongs to the file its edits are saved into. Without the engine the copy
 * stands, as on a desktop without its page tool; a rewrite qpdf refuses
 * refuses the open.
 */
async function normalizeBrowserWorkingCopyAppendBase(workingPath: TDocumentRef, fileName: string) {
    // A larger base cannot reach the page tool, which writes every edit; an
    // empty file is refused later as an empty PDF.
    const {size} = await browserDocumentStore.stat(workingPath);
    if (size === 0 || size > BROWSER_QPDF_MAX_INPUT_BYTES) {
        return;
    }
    const revision = await browserDocumentStore.getDocumentRevision(workingPath);
    const bytes = await browserDocumentStore.read(workingPath, {maxBytes: BROWSER_QPDF_MAX_INPUT_BYTES});
    let output: Uint8Array | null;
    try {
        ({output} = await normalizeBrowserPdfAppendBase(bytes));
    } catch (error) {
        if (isBrowserQpdfEngineUnavailableError(error)) {
            BrowserLogger.warn('working-copy', 'The qpdf engine is unavailable; the PDF opens without append admission', {error: getErrorMessage(error)});
            return;
        }
        if (error instanceof SerializableError && error.code === BROWSER_QPDF_ENGINE_ERROR_CODES.rewriteFailed) {
            throw new DocumentOpenRefusalError('invalid-pdf', `PDF rewrite failed: ${getErrorMessage(error)}`, {
                cause: error,
                fileName,
            });
        }
        throw error;
    }
    if (output === null) {
        return;
    }
    await browserDocumentStore.write(workingPath, output, {expectedDocumentRevisionToken: revision.token});
    BrowserLogger.warn('working-copy', 'Rewrote a PDF whose cross-reference chain cannot take an edit');
}

/**
 * Without a file to save back to, the decrypted or rewritten bytes of an opened PDF are what the person
 * opened: they start the document clean, so no restart offers them as unsaved work. A document with a file
 * keeps that file's bytes as its baseline, so Save still checks the file.
 */
export async function startOpenedWorkingCopyClean(workingPath: TDocumentRef) {
    const working = await browserDocumentStore.requireEntry(workingPath);
    if (working.doc && !working.doc.state().destination && working.doc.state().dirty) {
        await browserDocumentStore.replaceContent(workingPath, workingPath);
    }
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
    // The state of a document whose source is a picked file keeps saving to that file.
    const source = options.sourceRef ? await browserDocumentStore.ensureEntry(options.sourceRef).catch(() => null) : null;
    const workingPath = source?.saveHandle
        ? await browserDocumentStore.cloneAsWorkingCopy(source.ref, options.fileName, undefined, options.data)
        : await browserDocumentStore.createStoredDocument(options.fileName, options.data, {
            mimeType: options.mimeType ?? 'application/pdf',
            saveKind: 'pdf',
            kind: 'working',
            ...(options.sourceRef ? {sourceRef: options.sourceRef} : {}),
        });
    try {
        assertBrowserWorkingCopyDecrypted(await decryptBrowserWorkingCopy(workingPath, options.password));
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
) {
    const startedAt = Date.now();
    const normalizedPaths = normalizeNonEmptyStringPaths(paths).map((path) => {
        const parsed = parseDocumentRef(path);
        if (parsed === null) {
            throw new TypeError('Browser document paths must be document references');
        }
        return parsed;
    });

    if (normalizedPaths.length === 0) {
        return null;
    }

    const firstPath = normalizedPaths[0];
    if (!firstPath) {
        return null;
    }
    const firstFileName = getBrowserDocumentFileName(firstPath);
    const djvuPaths = normalizedPaths.filter((path) =>
        isDjvuFileName(getBrowserDocumentFileName(path)),
    );

    if (djvuPaths.length > 0) {
        if (normalizedPaths.length === 1 && djvuPaths.length === 1) {
            await touchRecentFileForOpen(firstPath);
            emitBatchOpenProgress(progressOptions, 1, 1, startedAt);
            return {
                kind: 'djvu',
                workingPath: '',
                originalPath: firstPath,
            } satisfies TOpenFileResult;
        }
    }

    if (normalizedPaths.length === 1 && isPdfFileName(firstFileName)) {
        const sourcePath = firstPath;
        // A picked file opens with its present bytes: the working copy's baseline is their witness.
        const workingPath = await browserDocumentStore.cloneAsWorkingCopy(sourcePath);
        let published = false;
        try {
            const decryption = await decryptBrowserWorkingCopy(workingPath, password);
            if (decryption.outcome === 'needs-password') {
                await touchRecentFileForOpen(sourcePath);
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
            await normalizeBrowserWorkingCopyAppendBase(workingPath, firstFileName);
            await startOpenedWorkingCopyClean(workingPath);
            await touchRecentFileForOpen(sourcePath);
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
            retention: 'durable',
        },
    );
    const workingPath = await browserDocumentStore.cloneAsWorkingCopy(originalPath);
    await touchRecentFileForOpen(originalPath);
    browserDocumentStore.unload(originalPath);

    return {
        kind: 'pdf',
        workingPath,
        originalPath,
        isGenerated: true,
    } satisfies TOpenFileResult;
}
