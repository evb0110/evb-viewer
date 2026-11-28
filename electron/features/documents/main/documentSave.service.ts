import {resolveTypedStagedArtifact} from '@electron/features/documents/main/managedTempFileHandles';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {copyNewFile} from '@document-store/nodeStorePort';
import type {IDocumentMutationRevisionOptions, IPdfSaveAsOptions} from '@contracts/electronApiDocuments';
import {parseDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import {basename, dirname, extname, join} from 'path';
import {addRecentFile} from '@electron/recentFiles';
import {updateRecentFilesMenu} from '@electron/menu';
import {allowDocxWritePath} from '@electron/file-access/docxExportPaths';
import {allowDjvuWritePath} from '@electron/features/djvu/public';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
    requireDocumentFile,
    requireOpenDocument,
    saveOpenDocument,
} from '@electron/file-access/documentStore';
import {allowOpenPath} from '@electron/file-access/openPathCapabilities';
import {isReservedTempPath} from '@electron/utils/pathValidator';
import {te} from '@electron/te';
import {validatePdfFile} from '@electron/features/documents/main/pdfConformance';
import {rewritePdfWithQpdf} from '@electron/pdf/pdfAppendBase';
import {enqueueWorkingCopyMutation} from '@electron/file-access/workingCopyMutationQueue';
import {optimizePdfForSaveAs} from '@electron/features/documents/public/pdfSaveAsOptimization';
import type {IDocumentsDialogContext} from '@electron/features/documents/documentsContexts';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {SavePublicationError} from '@document-store/saveDocument';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

const logger = createLogger('document-save');

export type TShowSaveDialogWithExtension = (
    context: IDocumentsDialogContext,
    options: {
        title: string;
        defaultPath: string;
        filterName: string;
        extension: string;
    },
) => Promise<string | null>;

function requireDocumentRef(value: unknown): TDocumentRef {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

async function promptForPdfSaveAsTarget(
    context: IDocumentsDialogContext,
    workingPath: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const originalPath = requireOpenDocument(workingPath, context.senderId).originalPath;
    const suggestedName = originalPath ? basename(originalPath) : basename(workingPath);
    return showSaveDialogWithExtension(context, {
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
}

export async function savePdfAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    options: IPdfSaveAsOptions | undefined,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
    revisionOptions?: IDocumentMutationRevisionOptions,
) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return null;
    }

    const extension = extname(normalizedWorkingPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }
    const entry = requireOpenDocument(normalizedWorkingPath, context.senderId);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);

    const targetPath = await promptForPdfSaveAsTarget(context, normalizedWorkingPath, showSaveDialogWithExtension);
    if (!targetPath) {
        return null;
    }
    if (isReservedTempPath(targetPath)) {
        throw new Error('Invalid file path: cannot save into reserved application directory');
    }

    await enqueueWorkingCopyMutation(entry.ref, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(entry.ref, expectedDocumentRevisionToken);
        // Pending annotations and an optimization are committed to the working copy first; Save As then
        // publishes exactly those bytes and makes the new file the document's destination.
        const tempPath = join(dirname(entry.ref), `.save-as-${randomUUID()}.pdf`);
        try {
            const stagedOutput = options?.stagedOutput ? await resolveTypedStagedArtifact(context, options.stagedOutput) : undefined;
            const sourcePath = stagedOutput?.path ?? (await requireDocumentFile(entry));
            // Damage the file already had is repaired once, by the qpdf rewrite a page edit's recovery uses.
            const damaged = !(await validatePdfFile(sourcePath)).isValid;
            let stagedForCommit = false;
            if (damaged) {
                if (
                    !(await rewritePdfWithQpdf(sourcePath, tempPath).then(
                        async () => (await validatePdfFile(tempPath)).isValid,
                        () => false,
                    ))
                ) {
                    throw new Error('Working copy is not a valid PDF');
                }
                stagedForCommit = true;
            } else if (stagedOutput) {
                await copyNewFile(sourcePath, tempPath);
                stagedForCommit = true;
            }
            // When neither repair nor a staged artifact produced `tempPath`, optimize directly from
            // `sourcePath` into `tempPath` so the live source file is never mutated and an ineligible
            // Save As skips staging copies completely.
            const optimizedValidation = stagedForCommit
                ? await optimizePdfForSaveAs(tempPath, options)
                : await optimizePdfForSaveAs(sourcePath, options, {outputPath: tempPath});
            let result: Awaited<ReturnType<typeof saveOpenDocument>>;
            try {
                result = await saveOpenDocument(entry, expectedDocumentRevisionToken, {
                    ...(stagedForCommit || optimizedValidation ? {commit: {kind: 'move' as const, file: tempPath}} : {}),
                    saveAs: targetPath,
                });
            } catch (error) {
                if (error instanceof SavePublicationError && error.externalWriteCommitted !== false) {
                    const detail =
                        error.externalWriteCommitted === true
                            ? `Saved copy "${basename(targetPath)}" was written, but document adoption failed: ${getErrorMessage(error)}`
                            : `Saved copy "${basename(targetPath)}" may have been written before an error interrupted confirmation: ${getErrorMessage(error)}`;
                    throw new Error(
                        encodeSerializableErrorEnvelope({
                            code: 'save-publication-outcome',
                            message: detail,
                            details: {externalWriteCommitted: error.externalWriteCommitted},
                        }),
                        {cause: error},
                    );
                }
                throw error;
            }
            if (result.status === 'stale-revision') {
                throw createStaleRevisionError({
                    documentRef: requireDocumentRef(entry.ref),
                    expectedRevision: expectedDocumentRevisionToken,
                    actualRevision: null,
                });
            }
            if (result.status !== 'saved') {
                throw new Error(`Save As did not complete: ${result.status}`);
            }
        } finally {
            await rm(tempPath, {force: true}).catch(() => undefined);
        }
    });

    allowOpenPath(targetPath, context.sender);
    try {
        await addRecentFile(targetPath);
        updateRecentFilesMenu();
    } catch (error) {
        logger.warn('Save As succeeded, but updating recent files failed', {
            targetPath,
            error: getErrorMessage(error),
        });
    }

    return requireDocumentRef(targetPath);
}

export async function savePdfDialog(
    context: IDocumentsDialogContext,
    suggestedName: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const normalizedSuggestedName =
        typeof suggestedName === 'string' && suggestedName.trim().length > 0 ? suggestedName.trim() : 'document.pdf';
    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.savePdf'),
        defaultPath: normalizedSuggestedName.endsWith('.pdf') ? normalizedSuggestedName : `${normalizedSuggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return null;
    }
    if (isReservedTempPath(targetPath)) {
        throw new Error('Invalid file path: cannot save into reserved application directory');
    }

    allowDjvuWritePath(targetPath, context.sender);

    return requireDocumentRef(targetPath);
}

export async function saveDocxAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';

    const suggestedBase = normalizedWorkingPath ? basename(normalizedWorkingPath, extname(normalizedWorkingPath)) : 'ocrText';

    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.saveOcrTextAs'),
        defaultPath: `${suggestedBase}.docx`,
        filterName: te('dialogs.wordDocuments'),
        extension: 'docx',
    });
    if (!targetPath) {
        return null;
    }
    if (isReservedTempPath(targetPath)) {
        throw new Error('Invalid file path: cannot save into reserved application directory');
    }

    allowDocxWritePath(targetPath, context.sender);

    return requireDocumentRef(targetPath);
}
