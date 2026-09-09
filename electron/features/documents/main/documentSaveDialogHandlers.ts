import {
    basename,
    extname,
} from 'path';
import {
    saveDocxAs,
    savePdfAs,
    savePdfDataAs,
    savePdfDialog,
} from '@electron/features/documents/main/documentSave.service';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { TDocumentRef } from '@contracts/documentRef';
import { showSaveDialogWithExtension } from '@electron/features/documents/main/documentDialogCommon';
import { beginSerializedPdfSaveAs } from '@electron/features/documents/main/serializedPdfPersistence';
import type { IBeginSerializedPdfSaveAsResult } from '@electron/features/documents/serializedPdfPersistenceContract';
import { getWorkingCopyOriginalPath } from '@electron/file-access/workingCopyStore';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { te } from '@electron/te';
import { normalizePdfSaveAsOptions } from '@electron/features/documents/public/pdfSaveAsOptimization';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsService';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';

export async function handleSavePdfAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    options?: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
) {
    return savePdfAs(
        context,
        workingPath,
        normalizePdfSaveAsOptions(options),
        showSaveDialogWithExtension,
        revisionOptions,
    );
}

export async function handleSavePdfDataAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    data: unknown,
    options?: unknown,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
): Promise<{
    path: TDocumentRef | null;
    validation: IPdfValidationResult | null;
}> {
    return savePdfDataAs(
        context,
        workingPath,
        data,
        normalizePdfSaveAsOptions(options),
        showSaveDialogWithExtension,
        serializedSaveOptions,
    );
}

export async function handleBeginSavePdfDataAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    totalBytes: number,
    options?: unknown,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
): Promise<IBeginSerializedPdfSaveAsResult> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return {
            sessionId: null,
            path: null,
        };
    }
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    const originalPath = getWorkingCopyOriginalPath(normalizedWorkingPath, context.senderId)?.originalPath;
    const suggestedName = originalPath
        ? basename(originalPath)
        : normalizedWorkingPath
            ? basename(normalizedWorkingPath, extname(normalizedWorkingPath))
            : 'document.pdf';
    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.savePdfAs'),
        defaultPath: suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`,
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });

    return beginSerializedPdfSaveAs(
        context,
        workingPath,
        totalBytes,
        targetPath,
        normalizePdfSaveAsOptions(options),
        serializedSaveOptions,
    );
}

export async function handleSavePdfDialog(
    context: IDocumentsDialogContext,
    suggestedName: string,
) {
    return savePdfDialog(context, suggestedName, showSaveDialogWithExtension);
}

export async function handleSaveDocxAs(
    context: IDocumentsDialogContext,
    workingPath: string,
) {
    return saveDocxAs(context, workingPath, showSaveDialogWithExtension);
}
