import {parseDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import type {IDocumentDirectOpenRequest, TOpenFileResult} from '@contracts/electronApiDocuments';
import {normalizeNonEmptyStringPaths} from '@contracts/shared';
import {browserDocumentStore, getBrowserDocumentFileName} from '@app/platform/browserDocumentStore';
import {ensurePdfExtension, isDjvuFileName, isPdfFileName} from '@app/platform/browser-api/browserFileName';
import {emitBatchOpenProgress, type IBrowserBatchOpenProgressOptions} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {containsPdfEncryptMarker, PDF_ENCRYPT_SCAN_REGION_BYTES} from '@pdf-core';
import {isPdfDecryptPassword, PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {MAX_DOCUMENT_ALLOCATION_BYTES} from '@contracts/electronApiDocuments';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {buildBrowserByteLimitError} from '@app/platform/browser-api/browserPlatformHelpers';
import {
    isBrowserQpdfEngineUnavailableError,
    normalizeBrowserPdfAppendBase,
    runBrowserQpdfCommand,
} from '@app/platform/browser-api/browserQpdfEngineClient';
import {BROWSER_QPDF_ENGINE_ERROR_CODES, BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import {SerializableError} from '@contracts/serializableError';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getErrorMessage} from '@app/utils/error';

async function touchRecentFileForOpen(ref: TDocumentRef, request: IDocumentDirectOpenRequest) {
    if (request.recordRecent === false) {
        return;
    }
    await browserDocumentStore.touchRecentFile(ref);
}

/**
 * Unlocks the working copy with `password` when it is encrypted and commits the result. `open`: an open's bytes, not
 * an edit (see the store's `write`); its `fileName` also gives the PDF its append base in that revision, as on desktop.
 */
export async function decryptBrowserWorkingCopy(workingPath: string, password?: string, open?: {fileName?: string}) {
    if (password !== undefined && !isPdfDecryptPassword(password)) {
        throw new Error(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
    }
    const revision = await browserDocumentStore.getDocumentRevision(workingPath);
    const {size} = await browserDocumentStore.stat(workingPath);
    const head = await browserDocumentStore.readRange(workingPath, 0, Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size));
    let encrypted = containsPdfEncryptMarker(head);
    if (!encrypted && size > head.byteLength) {
        const tailStart = Math.max(head.byteLength, size - PDF_ENCRYPT_SCAN_REGION_BYTES);
        const tail = await browserDocumentStore.readRange(workingPath, tailStart, size - tailStart);
        encrypted = containsPdfEncryptMarker(tail);
    }
    let unlocked: Uint8Array | null = null;
    if (encrypted) {
        // Unlocking rewrites the whole file in memory, within the decrypting reader's budget; edits then append to
        // the plaintext. A larger encrypted file is refused before it is read, with the desktop app as the way to it.
        if (size > MAX_DOCUMENT_ALLOCATION_BYTES) {
            throw buildBrowserByteLimitError(
                'Unlocking an encrypted PDF',
                MAX_DOCUMENT_ALLOCATION_BYTES,
                'files',
                '. Open it in the desktop app.',
            );
        }
        const result = await runBrowserPageOpsWorkerRequest('decrypt', {
            data: await browserDocumentStore.read(workingPath, {maxBytes: MAX_DOCUMENT_ALLOCATION_BYTES}),
            password: password ?? '',
        });
        if (isBrowserPageOpsWasmFailure(result)) {
            if (result.error.code === 'needs-password') {
                return {outcome: 'needs-password', wasEncrypted: true} as const;
            }
            if (result.error.code === 'unsupported-filter' || result.error.code === 'encrypted') {
                return {outcome: 'unsupported', wasEncrypted: true} as const;
            }
            throw new Error(result.error.message);
        }
        unlocked = new Uint8Array(result.data);
    }
    const bytes = open?.fileName === undefined ? unlocked : ((await normalizeAppendBase(workingPath, unlocked, open.fileName)) ?? unlocked);
    if (bytes) {
        await browserDocumentStore.write(workingPath, bytes, {expectedDocumentRevisionToken: revision.token, opened: open !== undefined});
    }
    return {outcome: encrypted ? 'decrypted' : 'plain', wasEncrypted: encrypted} as const;
}

/**
 * Desktop's `normalizePdfAppendBase` for a PDF being opened (`unlocked`, or the working copy's bytes): the qpdf rewrite
 * of one whose cross-reference chain an edit cannot extend, so the object numbers the viewer captures belong to the
 * file its edits are saved into; `null` when it stands, as without the engine. A rewrite qpdf refuses refuses the open.
 */
async function normalizeAppendBase(workingPath: string, unlocked: Uint8Array | null, fileName: string) {
    // The page tool, which writes every edit, takes no larger base; an empty PDF is refused later.
    const input = unlocked?.slice() ?? (await browserDocumentStore.readableBlob(workingPath));
    const size = input instanceof Blob ? input.size : input.byteLength;
    if (size === 0 || size > BROWSER_QPDF_MAX_INPUT_BYTES) {
        return null;
    }
    try {
        // The engine takes bytes over, so a copy keeps the unlocked bytes. A document's own bytes reach the engine
        // as the Blob of its file, which the engine's worker reads itself: the window never holds them whole.
        const {output} = await normalizeBrowserPdfAppendBase(input);
        if (output) {
            BrowserLogger.warn('working-copy', 'Rewrote a PDF whose cross-reference chain cannot take an edit');
        }
        return output;
    } catch (error) {
        if (isBrowserQpdfEngineUnavailableError(error)) {
            BrowserLogger.warn('working-copy', 'The qpdf engine is unavailable; the PDF opens without append admission', {
                error: getErrorMessage(error),
            });
            return null;
        }
        if (error instanceof SerializableError && error.code === BROWSER_QPDF_ENGINE_ERROR_CODES.rewriteFailed) {
            throw new DocumentOpenRefusalError('invalid-pdf', `PDF rewrite failed: ${getErrorMessage(error)}`, {
                cause: error,
                fileName,
            });
        }
        throw error;
    }
}

/**
 * The open's qpdf rewrite for a revision of an open working copy the page engine could not read, made without
 * asking the append admission; its edit then runs once more. Whether a new revision holds the rewrite.
 */
export async function repairBrowserWorkingCopy(workingPath: string, signal?: AbortSignal) {
    // One revision's file, read by range in the engine's worker, with the token that names it; the write below
    // refuses once the document changed, even by an edit undone again or a staged foreign revision.
    const {blob, token, byteRevision, instance} = await browserDocumentStore.readableRevision(workingPath);
    if (blob.size === 0 || blob.size > BROWSER_QPDF_MAX_INPUT_BYTES) {
        return false;
    }
    const output = await repairBrowserPdfBytes(blob, signal);
    if (output === null) {
        return false;
    }
    await browserDocumentStore.write(workingPath, output, {
        expectedDocumentRevisionToken: token,
        strictRevisionToken: true,
        expectedInstance: instance,
        ...(byteRevision === undefined ? {} : {expectedByteRevision: byteRevision}),
    });
    return true;
}

/** The open's qpdf rewrite, which rebuilds damage a PDF already had. */
export async function repairBrowserPdfBytes(input: Uint8Array | Blob, signal?: AbortSignal) {
    return (await runBrowserQpdfCommand('rewrite', input, signal ? {signal} : {})).output;
}

type TBrowserWorkingCopyDecryptionResult = Awaited<ReturnType<typeof decryptBrowserWorkingCopy>>;

export function assertBrowserWorkingCopyDecrypted(result: TBrowserWorkingCopyDecryptionResult) {
    if (result.outcome === 'needs-password') {
        throw new Error('PDF decryption requires a password');
    }
    if (result.outcome === 'unsupported') {
        throw new Error('PDF encryption handler is unsupported');
    }
}

export async function createBrowserWorkingCopyFromBytes(options: {
    fileName: string;
    data: Uint8Array | Blob;
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
    request: IDocumentDirectOpenRequest = {},
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
    const djvuPaths = normalizedPaths.filter((path) => isDjvuFileName(getBrowserDocumentFileName(path)));

    if (djvuPaths.length > 0) {
        if (normalizedPaths.length === 1 && djvuPaths.length === 1) {
            await touchRecentFileForOpen(firstPath, request);
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
        const sourceEntry = await browserDocumentStore.ensureEntry(sourcePath).catch(() => null);
        const isGenerated = sourceEntry?.kind === 'output';
        // A picked file opens with its present bytes: the working copy's baseline is their witness.
        const workingPath = await browserDocumentStore.cloneAsWorkingCopy(sourcePath);
        let published = false;
        try {
            const decryption = await decryptBrowserWorkingCopy(workingPath, request.password, {fileName: firstFileName});
            if (decryption.outcome === 'needs-password') {
                if (!isGenerated) {
                    await touchRecentFileForOpen(sourcePath, request);
                }
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
            if (!isGenerated) {
                await touchRecentFileForOpen(sourcePath, request);
            }
            browserDocumentStore.unload(sourcePath);
            emitBatchOpenProgress(progressOptions, 1, 1, startedAt);
            published = true;
            return {
                kind: 'pdf',
                workingPath,
                originalPath: sourcePath,
                ...(isGenerated ? {isGenerated: true as const} : {}),
                ...(decryption.wasEncrypted ? {wasEncrypted: true as const} : {}),
            } satisfies TOpenFileResult;
        } finally {
            if (!published) {
                await browserDocumentStore.remove(workingPath).catch(() => undefined);
            }
        }
    }

    const {createCombinedPdfFromPaths} = await import('@app/platform/browser-api/createCombinedPdfFromPaths');
    const generatedName =
        normalizedPaths.length === 1
            ? ensurePdfExtension(firstFileName.replace(/\.[^.]+$/u, ''))
            : ensurePdfExtension(`combined-${Date.now()}`);
    const originalPath = await createCombinedPdfFromPaths(normalizedPaths, progressOptions, {
        fileName: generatedName,
        kind: 'source',
        retention: 'durable',
    });
    const workingPath = await browserDocumentStore.cloneAsWorkingCopy(originalPath);
    await touchRecentFileForOpen(originalPath, request);
    browserDocumentStore.unload(originalPath);

    return {
        kind: 'pdf',
        workingPath,
        originalPath,
        isGenerated: true,
    } satisfies TOpenFileResult;
}
