import { existsSync } from 'fs';
import {
    rm,
    writeFile,
} from 'fs/promises';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSerializedSaveOptions,
    TDocumentSaveFailureReason,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    ensureWorkingCopyMaterialized,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { WorkingCopyMissingError } from '@electron/file-access/workingCopyMissingError';
import {normalizeIpcWritePayload} from '@electron/file-access/documentFileWriteAtomic';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import {
    enqueueWorkingCopyMutation,
    type IWorkingCopyMutationOperation,
} from '@electron/file-access/workingCopyMutationQueue';
import {
    awaitWorkingCopyRevisionDurability,
    clearWorkingCopySyncRequired,
    markWorkingCopyContentChanged,
} from '@electron/file-access/documentRevisionStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    assertQueuedWorkingCopyMutationPreconditionsForResync,
} from '@electron/file-access/documentMutationGuards';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import {captureOriginalPathSaveWitness} from '@electron/file-access/originalPathSaveWitness';
import {transitionOriginalAndWorkingCopyRevision} from '@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    optimizeLargePdfForOrdinarySave,
    optimizePdfForSave,
} from '@electron/features/documents/main/pdfSaveAsOptimization';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

const QPDF_REPAIR_SAVE_TIMEOUT_MS = parseIntegerEnv(
    'EVB_QPDF_REPAIR_SAVE_TIMEOUT_MS',
    10 * 60 * 1000,
    1_000,
);

function requireSenderId(context: IDocumentsSenderIdContext): number {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

interface IReplaceOriginalWithValidatedTempResult {
    validation: IPdfValidationResult;
    optimized: boolean;
}

function createOriginalChangedValidationResult(): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: ['Original file changed on disk; save skipped to avoid overwriting external edits'],
        warnings: [],
    };
}

function normalizeExpectedDocumentRevisionToken(options?: IPdfSerializedSaveOptions | null): TDocumentRevisionToken | null {
    const token = options?.expectedDocumentRevisionToken;
    if (token === undefined) {
        return null;
    }
    const parsedToken = parseDocumentRevisionToken(token);
    if (parsedToken === null) {
        throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    }
    return parsedToken;
}

function getValidationSaveFailureReason(validation: IPdfValidationResult): TDocumentSaveFailureReason {
    return validation.errors.some(error => (
        error.includes('Original file changed on disk')
        || error.includes('Document changed while save was being prepared')
    ))
        ? 'stale'
        : 'validation-failed';
}

function createSaveFailureResult(
    reason: TDocumentSaveFailureReason,
    error?: unknown,
    options: {
        externalWriteCommitted?: boolean;
        validation?: IPdfValidationResult | null;
    } = {},
): TDocumentSaveResult {
    const message = error === undefined ? undefined : getErrorMessage(error);
    return {
        ok: false,
        reason,
        ...(message === undefined ? {} : {message}),
        ...(options.externalWriteCommitted === undefined ? {} : {externalWriteCommitted: options.externalWriteCommitted}),
        ...(reason === 'working-copy-sync-required' ? {workingCopySyncRequired: true} : {}),
        ...(options.validation === undefined ? {} : {validation: options.validation}),
    };
}

function areWorkingCopyAndOriginalMissing(workingPath: string, senderWebContentsId: number) {
    const mapping = getWorkingCopyOriginalPath(workingPath, senderWebContentsId);
    return mapping !== null
        && !existsSync(workingPath)
        && !existsSync(mapping.originalPath);
}

async function refreshWorkingCopyOriginalFileExpectationForSave(workingPath: string, senderWebContentsId: number) {
    const refreshed = await refreshWorkingCopyOriginalFileExpectation(workingPath, senderWebContentsId);
    if (!refreshed) {
        throw new Error('Working copy registration changed before original expectation refresh completed');
    }
}

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

async function replaceOriginalWithValidatedTemp(
    originalPath: string,
    workingPath: string,
    senderWebContentsId: number,
    writeTemp: (tempPath: string) => Promise<void>,
    options: { optimize?: 'large' | 'force' } = {},
): Promise<IReplaceOriginalWithValidatedTempResult> {
    const tempPath = makeSiblingTempPath(originalPath);
    let replaced = false;
    try {
        await writeTemp(tempPath);
        const optimizedValidation = options.optimize === 'force'
            ? await optimizePdfForSave(tempPath, {
                force: true,
                label: 'qpdf(optimize-current-pdf)',
            })
            : options.optimize === 'large'
                ? await optimizeLargePdfForOrdinarySave(tempPath)
                : null;
        const validation = optimizedValidation ?? await validatePdfFile(tempPath);
        if (!validation.isValid) {
            return {
                validation,
                optimized: false,
            };
        }

        const transition = await transitionOriginalAndWorkingCopyRevision({
            workingCopyPath: workingPath,
            originalPath,
            reason: 'save-sync',
            senderId: senderWebContentsId,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(
                workingPath,
                originalPath,
                senderWebContentsId,
            ),
            publishOriginal: assertDestinationCurrent => atomicReplace(tempPath, originalPath, {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
            afterWorkingCopySync: () => refreshWorkingCopyOriginalFileExpectationForSave(
                workingPath,
                senderWebContentsId,
            ),
            afterOriginalRestore: () => refreshWorkingCopyOriginalFileExpectationForSave(
                workingPath,
                senderWebContentsId,
            ),
        });
        if (!transition) {
            return {
                validation: createOriginalChangedValidationResult(),
                optimized: false,
            };
        }
        replaced = true;
        return {
            validation,
            optimized: optimizedValidation !== null,
        };
    } finally {
        if (!replaced) {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
}

async function repairPdfWithQpdf(
    inputPath: string,
    outputPath: string,
    operation?: {
        signal: AbortSignal;
        cancelGroup: string;
    },
) {
    await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        inputPath,
        outputPath,
    ], {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: 'qpdf(repair-save)',
        timeoutMs: QPDF_REPAIR_SAVE_TIMEOUT_MS,
        ...(operation === undefined ? {} : {
            signal: operation.signal,
            cancelGroup: operation.cancelGroup,
        }),
    });
}

async function runNativePdfSaveMutation(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options: IDocumentMutationRevisionOptions | undefined,
    writeTemp: (
        normalizedWorkingPath: string,
        tempPath: string,
        operation: IWorkingCopyMutationOperation,
    ) => Promise<void>,
    optimize: 'large' | 'force',
    failureMessage: string,
): Promise<IPdfValidationResult> {
    const senderId = requireSenderId(context);
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    try {
        return await enqueueWorkingCopyMutation(normalizedWorkingPath, async operation => {
            await assertQueuedWorkingCopyMutationPreconditions(normalizedWorkingPath, expectedDocumentRevisionToken);
            await ensureWorkingCopyMaterialized(normalizedWorkingPath, {
                ownerWebContentsId: senderId,
                reason: 'native-mutation',
            });
            const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);

            const queuedSave = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => writeTemp(normalizedWorkingPath, tempPath, operation),
                { optimize },
            );
            return queuedSave.validation;
        });
    } catch (err) {
        if (err instanceof WorkingCopyMaterializationError || err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`${failureMessage}: ${getErrorMessage(err)}`);
    }
}

export async function handleFileSaveStructured(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    try {
        const senderId = requireSenderId(context);
        if (!workingPath || workingPath.trim() === '') {
            return createSaveFailureResult('write-failed', new Error('Invalid file path'));
        }

        const normalizedWorkingPath = workingPath.trim();
        const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
        const saveResult = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(normalizedWorkingPath, expectedDocumentRevisionToken);
            await ensureWorkingCopyMaterialized(normalizedWorkingPath, {
                ownerWebContentsId: senderId,
                reason: 'save',
            });
            const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);

            const queuedSave = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => copyFileCopyOnWrite(normalizedWorkingPath, tempPath),
                { optimize: 'large' },
            );
            if (queuedSave.validation.isValid) {
                return {
                    validation: queuedSave.validation,
                    workingCopyRefreshed: true,
                };
            }

            return {
                validation: queuedSave.validation,
                workingCopyRefreshed: false,
            };
        });

        if (!saveResult.validation.isValid) {
            return createSaveFailureResult(
                getValidationSaveFailureReason(saveResult.validation),
                undefined,
                {
                    externalWriteCommitted: false,
                    validation: saveResult.validation,
                },
            );
        }

        return {
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: saveResult.validation,
        };
    } catch (err) {
        if (
            typeof context.senderId === 'number'
            && areWorkingCopyAndOriginalMissing(workingPath.trim(), context.senderId)
        ) {
            return createSaveFailureResult(
                'working-copy-missing',
                new WorkingCopyMissingError('Working copy and original file are unavailable'),
                {
                    externalWriteCommitted: false,
                    validation: null,
                },
            );
        }
        if (err instanceof WorkingCopyMaterializationError) {
            throw err;
        }
        if (err instanceof WorkingCopyMissingError) {
            return createSaveFailureResult('working-copy-missing', err, {
                externalWriteCommitted: false,
                validation: null,
            });
        }
        return createSaveFailureResult('write-failed', err, {
            externalWriteCommitted: false,
            validation: null,
        });
    }
}

export async function handleResyncWorkingCopy(
    context: IDocumentsSenderIdContext,
    workingPath: string,
): Promise<TDocumentSaveResult> {
    try {
        const senderId = requireSenderId(context);
        if (!workingPath || workingPath.trim() === '') {
            return createSaveFailureResult('write-failed', new Error('Invalid file path'), {
                externalWriteCommitted: false,
                validation: null,
            });
        }

        const normalizedWorkingPath = workingPath.trim();
        await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            assertQueuedWorkingCopyMutationPreconditionsForResync(
                normalizedWorkingPath,
                senderId,
                'resync-after-external-change',
            );
            await awaitWorkingCopyRevisionDurability(normalizedWorkingPath);
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, senderId)) {
                throw new WorkingCopyMissingError('Working copy path is not managed');
            }
            const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);
            await copyFileCopyOnWrite(originalPath, normalizedWorkingPath);
            await refreshWorkingCopyOriginalFileExpectationForSave(normalizedWorkingPath, senderId);
            clearWorkingCopySyncRequired(normalizedWorkingPath);
            await markWorkingCopyContentChanged(normalizedWorkingPath, 'save-sync', senderId);
        });

        return {
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
            validation: null,
        };
    } catch (error) {
        if (error instanceof WorkingCopyMissingError) {
            return createSaveFailureResult('working-copy-missing', error, {
                externalWriteCommitted: false,
                validation: null,
            });
        }
        return createSaveFailureResult('write-failed', error, {
            externalWriteCommitted: false,
            validation: null,
        });
    }
}

export async function handleSerializedPdfSave(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    data: unknown,
    options?: IPdfSerializedSaveOptions,
): Promise<IPdfValidationResult> {
    const senderId = requireSenderId(context);
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const payload = normalizeIpcWritePayload(data);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    try {
        const validation = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(normalizedWorkingPath, expectedDocumentRevisionToken);
            await ensureWorkingCopyMaterialized(normalizedWorkingPath, {
                ownerWebContentsId: senderId,
                reason: 'serialized-persistence',
            });
            const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);

            const queuedSave = await replaceOriginalWithValidatedTemp(
                originalPath,
                normalizedWorkingPath,
                senderId,
                tempPath => writeFile(tempPath, payload),
                { optimize: 'large' },
            );
            if (queuedSave.validation.isValid) {
                return queuedSave.validation;
            }

            return queuedSave.validation;
        });
        if (!validation.isValid) {
            return validation;
        }

        return validation;
    } catch (err) {
        if (err instanceof WorkingCopyMaterializationError) {
            throw err;
        }
        if (err instanceof WorkingCopyMissingError) {
            throw err;
        }
        throw new Error(`Failed to save: ${getErrorMessage(err)}`);
    }
}

export async function handleRepairPdfSave(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options?: IDocumentMutationRevisionOptions,
): Promise<IPdfValidationResult> {
    return runNativePdfSaveMutation(
        context,
        workingPath,
        options,
        repairPdfWithQpdf,
        'large',
        'Failed to repair and save',
    );
}

export async function handleOptimizePdfForInteraction(
    context: IDocumentsSenderIdContext,
    workingPath: string,
    options?: IDocumentMutationRevisionOptions,
): Promise<IPdfValidationResult> {
    return runNativePdfSaveMutation(
        context,
        workingPath,
        options,
        (normalizedWorkingPath, tempPath) => copyFileCopyOnWrite(normalizedWorkingPath, tempPath),
        'force',
        'Failed to optimize PDF',
    );
}
