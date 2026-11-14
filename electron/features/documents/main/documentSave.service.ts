import {resolveTypedStagedArtifact} from '@electron/features/documents/main/managedTempFileHandles';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {
    copyFile,
    rm,
} from 'node:fs/promises';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSaveAsOptions,
} from '@contracts/electronApiDocuments';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { allowDocxWritePath } from '@electron/file-access/docxExportPaths';
import { allowDjvuWritePath } from '@electron/features/djvu/public';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
    requireDocumentFile,
    requireOpenDocument,
    saveOpenDocument,
} from '@electron/file-access/documentStore';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { te } from '@electron/te';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { rewritePdfWithQpdf } from '@electron/pdf/pdfAppendBase';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { optimizePdfForSaveAs } from '@electron/features/documents/public/pdfSaveAsOptimization';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsContexts';
import {createStaleRevisionError} from '@contracts/documentMutationErrors';

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
    const suggestedName = originalPath
        ? basename(originalPath)
        : basename(workingPath);
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

    const targetPath = await promptForPdfSaveAsTarget(
        context,
        normalizedWorkingPath,
        showSaveDialogWithExtension,
    );
    if (!targetPath) {
        return null;
    }

    await enqueueWorkingCopyMutation(entry.ref, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(entry.ref, expectedDocumentRevisionToken);
        // Pending annotations and an optimization are committed to the working copy first; Save As then
        // publishes exactly those bytes and makes the new file the document's destination.
        const tempPath = join(dirname(entry.ref), `.save-as-${randomUUID()}.pdf`);
        try {
            const stagedOutput = options?.stagedOutput
                ? await resolveTypedStagedArtifact(context, options.stagedOutput)
                : undefined;
            const sourcePath = stagedOutput?.path ?? await requireDocumentFile(entry);
            // Damage the file already had is repaired once, by the qpdf rewrite a page edit's recovery uses.
            const damaged = !(await validatePdfFile(sourcePath)).isValid;
            if (!damaged) {
                await copyFile(sourcePath, tempPath, constants.COPYFILE_FICLONE);
            } else if (!await rewritePdfWithQpdf(sourcePath, tempPath).then(async () => (await validatePdfFile(tempPath)).isValid, () => false)) {
                throw new Error('Working copy is not a valid PDF');
            }
            const optimizedValidation = await optimizePdfForSaveAs(tempPath, options);
            const result = await saveOpenDocument(entry, expectedDocumentRevisionToken, {
                ...(optimizedValidation || stagedOutput || damaged ? {commit: {kind: 'move' as const, file: tempPath}} : {}),
                saveAs: targetPath,
            });
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
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    });

    allowOpenPath(targetPath, context.sender);
    await addRecentFile(targetPath);
    updateRecentFilesMenu();

    return requireDocumentRef(targetPath);
}


export async function savePdfDialog(
    context: IDocumentsDialogContext,
    suggestedName: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const normalizedSuggestedName = typeof suggestedName === 'string' && suggestedName.trim().length > 0
        ? suggestedName.trim()
        : 'document.pdf';
    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.savePdf'),
        defaultPath: normalizedSuggestedName.endsWith('.pdf') ? normalizedSuggestedName : `${normalizedSuggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return null;
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

    const suggestedBase = normalizedWorkingPath
        ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
        : 'ocrText';

    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.saveOcrTextAs'),
        defaultPath: `${suggestedBase}.docx`,
        filterName: te('dialogs.wordDocuments'),
        extension: 'docx',
    });
    if (!targetPath) {
        return null;
    }

    allowDocxWritePath(targetPath, context.sender);

    return requireDocumentRef(targetPath);
}
