import {
    saveDocxAs,
    savePdfAs,
    savePdfDialog,
} from '@electron/features/documents/main/documentSave.service';
import { showSaveDialogWithExtension } from '@electron/features/documents/main/documentDialogCommon';
import { normalizePdfSaveAsOptions } from '@electron/features/documents/public/pdfSaveAsOptimization';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsContexts';
import type {IDocumentMutationRevisionOptions} from '@contracts/electronApiDocuments';

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
