import type {
    IPdfConformanceAnalysisOptions,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type { IPdfPathValidationOptions } from '@contracts/electronApiDocuments';
import {
    analyzePdfConformanceFile,
    validatePdfFile,
    validatePdfFileForOpening,
    validatePdfFileForSave,
} from '@electron/features/documents/main/pdfConformance';
import {runWithWorkingCopyReadBacking} from '@electron/file-access/runWithWorkingCopyReadBacking';
import {getWorkingCopyBackingEntry} from '@electron/file-access/workingCopyStore';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';

async function readResolvedPdf<T>(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    read: (physicalPath: string) => Promise<T>,
) {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    if (!getWorkingCopyBackingEntry(resolvedPath, context.senderId)) {
        return read(resolvedPath);
    }
    return runWithWorkingCopyReadBacking<T>(
        resolvedPath,
        physicalPath => read(physicalPath),
        context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId},
    );
}

export async function handleAnalyzePdfConformance(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options?: IPdfConformanceAnalysisOptions,
): Promise<IPdfConformanceProfile> {
    return readResolvedPdf(
        context,
        filePath,
        physicalPath => analyzePdfConformanceFile(physicalPath, {markerEvidence: options?.purpose === 'save-restrictions'
            ? 'structural-only'
            : 'full'}),
    );
}


export async function handleValidatePdfPath(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options?: IPdfPathValidationOptions,
): Promise<IPdfValidationResult> {
    return readResolvedPdf(
        context,
        filePath,
        options?.purpose === 'opening'
            ? validatePdfFileForOpening
            : options?.purpose === 'save'
                ? validatePdfFileForSave
                : validatePdfFile,
    );
}
