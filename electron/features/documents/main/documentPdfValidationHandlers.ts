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
import { resolveOriginalBackedReadTransport } from '@electron/features/documents/main/documentFileReadHandlers';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';

async function readResolvedPdf<T>(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    read: (physicalPath: string) => Promise<T>,
) {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    const originalBackedRead = resolveOriginalBackedReadTransport(resolvedPath, context.senderId);
    return originalBackedRead
        ? originalBackedRead.read(read)
        : read(resolvedPath);
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
