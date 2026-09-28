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
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
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
    const workingCopyPath = typeof filePath === 'string'
        && getWorkingCopyBackingEntry(filePath, context.senderId)
        ? filePath
        : undefined;
    const operation = workingCopyPath === undefined
        ? undefined
        : registerMainOperation({
            kind: 'abortable-work',
            ...(context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId}),
            workingCopyPath,
            // The worker listens to operation.signal; the lifecycle hook marks
            // this read as eligible for cancellation when the copy is released.
            cancel: () => undefined,
        });
    try {
        return await readResolvedPdf(
            context,
            filePath,
            physicalPath => analyzePdfConformanceFile(physicalPath, {
                markerEvidence: options?.purpose === 'save-restrictions'
                    ? 'structural-only'
                    : 'full',
                ...(operation === undefined ? {} : {signal: operation.signal}),
            }),
        );
    } finally {
        operation?.complete();
    }
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
