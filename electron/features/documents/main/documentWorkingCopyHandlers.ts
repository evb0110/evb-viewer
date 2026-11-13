import {
    extname,
    isAbsolute,
} from 'path';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import {
    commitDocumentMutation,
    createDocumentFromSource,
    discardOpenDocument,
    extensionOf,
    findWorkingCopyPathByOriginalPath,
    forkOpenDocument,
    getWorkingCopyBackingEntry,
    normalizeExpectedDocumentRevisionToken,
    openDocumentFromFile,
    requireDocumentFile,
    requireOpenDocument,
    restoreOpenDocumentRevision,
    retainOpenDocumentRevisions,
    rewriteOpenDocument,
    type IOpenDocument,
} from '@electron/file-access/documentStore';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { isPdfFileEncrypted } from '@electron/file-access/isPdfFileEncrypted';
import {
    decryptWorkingCopyWithWriter,
    PdfDecryptAttemptError,
} from '@electron/file-access/workingCopyDecryption';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {
    normalizePdfAppendBase,
    pdfNeedsAppendBaseRewrite,
} from '@electron/pdf/pdfAppendBase';
import { createLogger } from '@electron/utils/createLogger';
import { IPC_FILENAME_MAX_LENGTH } from '@electron/utils/ipcLimits';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';
import {
    isPdfDecryptPassword,
    PDF_DECRYPT_PASSWORD_MAX_BYTES,
} from '@contracts/pdfDecryptSchemas';

const logger = createLogger('documents-dialogs');
const MAX_WORKING_COPY_DATA_BYTES = 16 * 1024 * 1024;

function assertOptionalPdfDecryptPassword(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPdfDecryptPassword(value)) {
        throw new Error(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
    }
    return value;
}

const isPdfPath = (path: string) => extname(path).trim().toLowerCase() === '.pdf';

interface IPreparePdfOptions {
    password?: string | undefined;
    signal?: AbortSignal | undefined;
    /** Takes the resources a whole-file rewrite needs before it starts. */
    admitRewrite?: (() => Promise<void>) | undefined;
}

/**
 * Decrypting or repairing a PDF is its first mutation, made before anyone reads it: the viewer reads decrypted
 * bytes, and the object numbers it captures belong to the file its edits are appended to. An ordinary PDF is left
 * as it is and the document stays without bytes of its own. A wrong password removes the document.
 */
async function preparePdf(entry: IOpenDocument, readPath: string, options: IPreparePdfOptions) {
    let wasEncrypted = false;
    try {
        const encrypted = await isPdfFileEncrypted(readPath);
        if (!encrypted && !await pdfNeedsAppendBaseRewrite(readPath, options.signal)) return false;
        await rewriteOpenDocument(entry, async (staged) => {
            if (encrypted) {
                const decryption = await decryptWorkingCopyWithWriter(staged, options.password, options.signal);
                if (decryption.outcome === 'needs-password' || decryption.outcome === 'unsupported') {
                    throw new PdfDecryptAttemptError(decryption.outcome === 'needs-password' ? 'needs-password' : 'unsupported-encryption');
                }
                wasEncrypted = decryption.wasEncrypted;
            }
            await normalizePdfAppendBase(staged, staged, {
                ...(options.signal ? {signal: options.signal} : {}),
                ...(options.admitRewrite ? {admitRewrite: options.admitRewrite} : {}),
            });
        }, 'open');
    } catch (error) {
        await discardOpenDocument(entry);
        throw error;
    }
    return wasEncrypted;
}

/** Opens the PDF or image at `path` as a document whose Save replaces that file. */
export async function openFileAsDocument(path: TOpenPath, ownerWebContentsId: number | undefined, options: IPreparePdfOptions = {}) {
    const entry = await openDocumentFromFile(path, ownerWebContentsId === undefined ? {} : {ownerWebContentsId});
    const wasEncrypted = isPdfPath(path) ? await preparePdf(entry, path, options) : false;
    return {entry, wasEncrypted};
}

/** A new document holding the bytes of `source` that Save As publishes; `originalPath` only names it. */
export async function createDocumentFromFile(source: TOpenPath, originalPath: string | undefined, ownerWebContentsId?: number) {
    const entry = await createDocumentFromSource(source, {
        ext: extensionOf(source),
        ...(originalPath === undefined ? {} : {originalPath}),
        ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
    });
    if (isPdfPath(source)) await preparePdf(entry, await requireDocumentFile(entry), {});
    return entry;
}

/**
 * New bytes for a document already open from `originalPath`, such as a moved tab's unsaved state: a copy of that
 * document, so its Save keeps checking and replacing the same file, rewritten with `source`.
 */
async function createRevisionOf(document: IOpenDocument, source: string | Uint8Array, ownerWebContentsId?: number) {
    const entry = await forkOpenDocument(document, ownerWebContentsId);
    try {
        await commitDocumentMutation(entry, null, {
            kind: 'rewrite',
            source: typeof source === 'string'
                ? source
                : file => file.writeAt(0, source),
        }, 'replace-working-copy');
    } catch (error) {
        await discardOpenDocument(entry);
        throw error;
    }
    return entry;
}

/**
 * A document holding the bytes of `source`: a new revision of the document open from `originalPath` when there is
 * one this window may use, so its Save keeps its destination, otherwise a new document Save As publishes.
 */
export async function createDocumentForOriginal(source: TOpenPath, originalPath: string | undefined, ownerWebContentsId: number) {
    const ref = originalPath === undefined ? null : findWorkingCopyPathByOriginalPath(originalPath, ownerWebContentsId);
    const document = ref ? getWorkingCopyBackingEntry(ref, ownerWebContentsId) : null;
    return document ? createRevisionOf(document, source, ownerWebContentsId) : createDocumentFromFile(source, originalPath, ownerWebContentsId);
}

function resolveTrustedOriginalDocument(originalPath: string | undefined, warningContext: string, senderId?: number) {
    const normalized = typeof originalPath === 'string' && originalPath.trim().length > 0 ? originalPath : undefined;
    if (normalized && (!isAbsolute(normalized) || !isSupportedOpenPath(normalized))) {
        throw new Error('Invalid original path');
    }
    const ref = normalized ? findWorkingCopyPathByOriginalPath(normalized, senderId) : null;
    if (normalized && !ref) logger.warn(`Ignoring untrusted original path for ${warningContext}`);
    return ref ? requireOpenDocument(ref, senderId) : null;
}

export async function handleCreateWorkingCopyFromData(
    context: IDocumentsSenderIdContext,
    fileName: string,
    data: Uint8Array,
    originalPath?: string,
    password?: string,
) {
    const normalizedName = typeof fileName === 'string' ? fileName.trim() : '';
    if (!normalizedName || normalizedName.length > IPC_FILENAME_MAX_LENGTH) {
        throw new Error('Invalid file name');
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_WORKING_COPY_DATA_BYTES) {
        throw new Error('Invalid PDF payload');
    }
    const validatedPassword = assertOptionalPdfDecryptPassword(password);
    const document = resolveTrustedOriginalDocument(originalPath, 'createWorkingCopyFromData', context.senderId);
    if (document) return (await createRevisionOf(document, data, context.senderId)).ref;
    const entry = await createDocumentFromSource(data, {
        ext: extensionOf(normalizedName),
        ...(context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId}),
    });
    if (isPdfPath(normalizedName)) await preparePdf(entry, await requireDocumentFile(entry), {password: validatedPassword});
    return entry.ref;
}

export async function handleCreateWorkingCopyFromPath(
    context: IDocumentsSenderIdContext,
    sourcePath: TOpenPath,
    originalPath?: string,
    password?: string,
) {
    if (!isSupportedOpenPath(sourcePath)) {
        throw new Error('Invalid source file type');
    }
    const validatedPassword = assertOptionalPdfDecryptPassword(password);
    const source = getWorkingCopyBackingEntry(sourcePath, context.senderId);
    if (source) return (await forkOpenDocument(source, context.senderId)).ref;
    const document = originalPath === sourcePath
        ? null
        : resolveTrustedOriginalDocument(originalPath, 'createWorkingCopyFromPath', context.senderId);
    if (document) return (await createRevisionOf(document, sourcePath, context.senderId)).ref;
    return (await openFileAsDocument(sourcePath, context.senderId, {password: validatedPassword})).entry.ref;
}

/** Undo or redo of the document's bytes, in order with its other mutations. */
export function handleRestoreDocumentRevision(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    revision: TDocumentRevisionToken,
    options?: IDocumentMutationRevisionOptions,
) {
    const entry = requireOpenDocument(workingPath, context.senderId);
    const expected = normalizeExpectedDocumentRevisionToken(options);
    return enqueueWorkingCopyMutation(entry.ref, () => restoreOpenDocumentRevision(entry, revision, expected));
}

export function handleRetainDocumentRevisions(context: IDocumentsSenderIdContext, workingPath: string, revisions: TDocumentRevisionToken[]) {
    return retainOpenDocumentRevisions(requireOpenDocument(workingPath, context.senderId), revisions).then(() => undefined);
}
