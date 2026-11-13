import {randomUUID} from 'node:crypto';
import {
    constants,
} from 'node:fs';
import {
    copyFile,
    rm,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import type {TSaveResult} from '@document-store/saveDocument';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type {
    IDocumentMutationRevisionOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import { getErrorMessage } from '@electron/utils/error';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    getDocumentRevisionInfo,
    normalizeExpectedDocumentRevisionToken,
    requireDocumentFile,
    requireOpenDocument,
    saveOpenDocument,
    type IOpenDocument,
} from '@electron/file-access/documentStore';
import {explainWriteRefusal} from '@electron/file-access/explainWriteRefusal';
import {
    validatePdfFile,
    validatePdfFileForSave,
} from '@electron/features/documents/main/pdfConformance';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { rewritePdfWithQpdf } from '@electron/pdf/pdfAppendBase';
import { createLogger } from '@electron/utils/createLogger';
import {
    optimizeLargePdfForOrdinarySave,
    optimizePdfForSave,
} from '@electron/features/documents/main/pdfSaveAsOptimization';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';

const logger = createLogger('working-copy-save');

function requireSenderId(context: IDocumentsSenderIdContext): number {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function createOriginalChangedValidationResult(): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: ['Original file changed on disk; save skipped to avoid overwriting external edits'],
        warnings: [],
    };
}

/**
 * The renderer's view of a Save. A save that found the PDF changed elsewhere after displacing it published the
 * document and kept those bytes beside the PDF: it is reported as refused, naming that file, as T3 asks.
 */
export function toDocumentSaveResult(
    entry: IOpenDocument,
    result: TSaveResult,
    validation: IPdfValidationResult | null,
): TDocumentSaveResult {
    switch (result.status) {
        case 'saved':
            return result.keptOriginal === undefined
                ? {
                    ok: true,
                    externalWriteCommitted: true,
                    workingCopyRefreshed: true,
                    documentRevision: getDocumentRevisionInfo(entry),
                    validation,
                }
                : {
                    ok: false,
                    reason: 'original-changed',
                    keptFilePath: result.keptOriginal,
                    externalWriteCommitted: true,
                    validation,
                };
        case 'conflict':
            return {
                ok: false,
                reason: 'original-changed',
                ...(result.keptOriginal === undefined ? {} : {keptFilePath: result.keptOriginal}),
                externalWriteCommitted: false,
                validation: null,
            };
        case 'stale-revision':
            return {ok: false, reason: 'stale', externalWriteCommitted: false, validation: null};
        case 'needs-save-as':
            return {ok: false, reason: 'unsupported', message: 'This document has no file to save to; use Save As', externalWriteCommitted: false, validation: null};
    }
}

/** A temporary file beside the document's revisions, so committing it clones it. */
function documentTempPath(entry: IOpenDocument, label: string) {
    return join(dirname(entry.ref), `.${label}-${randomUUID()}.pdf`);
}

/**
 * Prepares new bytes with a native tool from the current ones, validates them, and saves them: the commit makes
 * them the working copy's revision before anything is published.
 */
async function saveRewritten(
    entry: IOpenDocument,
    token: ReturnType<typeof normalizeExpectedDocumentRevisionToken>,
    rewrite: (currentPath: string, outputPath: string) => Promise<IPdfValidationResult | null>,
) {
    const tempPath = documentTempPath(entry, 'save');
    try {
        const optimized = await rewrite(await requireDocumentFile(entry), tempPath);
        const validation = optimized ?? await validatePdfFile(tempPath);
        if (!validation.isValid) return validation;
        const saved = await saveOpenDocument(entry, token, {commit: {kind: 'rewrite', source: tempPath}});
        return saved.status === 'saved' && saved.keptOriginal === undefined ? validation : createOriginalChangedValidationResult();
    } finally {
        await rm(tempPath, {force: true}).catch(() => undefined);
    }
}

async function runNativePdfSaveMutation(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options: IDocumentMutationRevisionOptions | undefined,
    rewrite: (currentPath: string, outputPath: string) => Promise<IPdfValidationResult | null>,
    failureMessage: string,
): Promise<IPdfValidationResult> {
    const entry = requireOpenDocument(typeof workingPath === 'string' ? workingPath.trim() : '', requireSenderId(context));
    const token = normalizeExpectedDocumentRevisionToken(options);
    try {
        return await enqueueWorkingCopyMutation(entry.ref, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(entry.ref, token);
            return saveRewritten(entry, token, rewrite);
        });
    } catch (err) {
        throw new Error(`${failureMessage}: ${getErrorMessage(await explainWriteRefusal(err, entry.originalPath ?? ''))}`, {cause: err});
    }
}

/** Save: the working copy's bytes, validated, replace the PDF after the check. Nothing new is committed first. */
export async function handleFileSaveStructured(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    const senderId = requireSenderId(context);
    const entry = requireOpenDocument(typeof workingPath === 'string' ? workingPath.trim() : '', senderId);
    const token = normalizeExpectedDocumentRevisionToken(options);
    try {
        return await enqueueWorkingCopyMutation(entry.ref, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(entry.ref, token);
            const {current, dirty} = entry.doc.state();
            const validation = current && dirty ? await validatePdfFileForSave(await requireDocumentFile(entry)) : null;
            if (validation && !validation.isValid) {
                logger.warn('Structured working-copy save rejected', {
                    channel: 'file:saveStructured',
                    phase: 'validate-before-publish',
                    error: validation.errors[0] ?? null,
                });
                return {ok: false, reason: 'validation-failed', externalWriteCommitted: false, validation};
            }
            return toDocumentSaveResult(entry, await saveOpenDocument(entry, token), validation);
        });
    } catch (err) {
        const error = await explainWriteRefusal(err, entry.originalPath ?? '');
        logger.warn('Structured working-copy save failed', {
            channel: 'file:saveStructured',
            phase: 'publish',
            error: getErrorMessage(error),
        });
        return {
            ok: false,
            reason: 'write-failed',
            message: getErrorMessage(error),
            externalWriteCommitted: false,
            validation: null,
        };
    }
}

export async function handleRepairPdfSave(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options?: IDocumentMutationRevisionOptions,
): Promise<IPdfValidationResult> {
    return runNativePdfSaveMutation(context, workingPath, options, async (currentPath, outputPath) => {
        await rewritePdfWithQpdf(currentPath, outputPath);
        return optimizeLargePdfForOrdinarySave(outputPath);
    }, 'Failed to repair and save');
}

export async function handleOptimizePdfForInteraction(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options?: IDocumentMutationRevisionOptions,
): Promise<IPdfValidationResult> {
    return runNativePdfSaveMutation(context, workingPath, options, async (currentPath, outputPath) => {
        await copyFile(currentPath, outputPath, constants.COPYFILE_FICLONE);
        return optimizePdfForSave(outputPath, {
            force: true,
            label: 'qpdf(optimize-current-pdf)',
        });
    }, 'Failed to optimize PDF');
}
