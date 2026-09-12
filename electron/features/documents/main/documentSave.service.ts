import {resolveTypedStagedArtifact} from '@electron/features/documents/main/managedTempFileHandles';
import { existsSync } from 'fs';
import {
    rm,
    writeFile,
} from 'fs/promises';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
    IPdfSaveAsResult,
    IPdfSaveAsWarning,
} from '@contracts/electronApiDocuments';
import { createWorkingCopySyncWarning } from '@contracts/electronApiDocuments';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    basename,
    extname,
} from 'path';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { allowDocxWritePath } from '@electron/file-access/docxExportPaths';
import { allowDjvuWritePath } from '@electron/features/djvu/public';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    getWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { te } from '@electron/te';
import {makeSiblingTempPath} from '@electron/utils/atomicReplace';
import { commitPdfTempFile } from '@electron/features/documents/main/commitPdfTempFile';
import { getErrorMessage } from '@electron/utils/error';
import {
    copyFileAtomic, normalizeIpcWritePayload,
} from '@electron/file-access/documentFileWriteAtomic';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import {capturePathSaveWitness} from '@electron/file-access/originalPathSaveWitness';
import {transitionOriginalAndWorkingCopyRevision} from '@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision';
import { optimizePdfForSaveAs } from '@electron/features/documents/public/pdfSaveAsOptimization';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsService';
import {markWorkingCopySyncRequired} from '@electron/file-access/documentRevisionStore';
import { assertQueuedWorkingCopyMutationPreconditions } from '@electron/file-access/documentMutationGuards';

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

function markSaveAsWorkingCopySyncRequired(
    workingPath: string,
    targetPath: string,
    senderId: number,
    error: unknown,
) {
    return markWorkingCopySyncRequired(
        workingPath,
        `Target file was saved, but the working copy refresh failed: ${getErrorMessage(error)}`,
        {
            originalPath: targetPath,
            ownerWebContentsId: senderId,
        },
    );
}

async function promptForPdfSaveAsTarget(
    context: IDocumentsDialogContext,
    workingPath: string,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, context.senderId)?.originalPath;
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

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);

    const targetPath = await promptForPdfSaveAsTarget(
        context,
        normalizedWorkingPath,
        showSaveDialogWithExtension,
    );
    if (!targetPath) {
        return null;
    }

    await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(normalizedWorkingPath, expectedDocumentRevisionToken);
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
            throw new Error('Working copy path is not managed');
        }
        if (!existsSync(normalizedWorkingPath)) {
            throw new Error(`File not found: ${normalizedWorkingPath}`);
        }

        const tempPath = makeSiblingTempPath(targetPath);
        let replaced = false;
        try {
            const stagedOutput = options?.stagedOutput
                ? await resolveTypedStagedArtifact(context, options.stagedOutput)
                : undefined;
            const sourcePath = stagedOutput?.path ?? normalizedWorkingPath;
            const validation = await validatePdfFile(sourcePath);
            if (!validation.isValid) {
                throw new Error('Working copy is not a valid PDF');
            }

            await copyFileCopyOnWrite(sourcePath, tempPath);
            await optimizePdfForSaveAs(tempPath, options);
            const transition = await transitionOriginalAndWorkingCopyRevision({
                workingCopyPath: normalizedWorkingPath,
                originalPath: targetPath,
                reason: 'save-sync',
                senderId: context.senderId,
                allowMissingOriginalWitness: true,
                preservePublishedOriginalOnWorkingCopySyncFailure: true,
                useDestinationWitnessForPublication: false,
                captureOriginalWitness: () => capturePathSaveWitness(targetPath),
                publishOriginal: async assertDestinationCurrent => {
                    await commitPdfTempFile(
                        tempPath,
                        targetPath,
                        {
                            ownerId: `pdf-save-as:${context.senderId}`,
                            ...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent}),
                        },
                    );
                },
                afterOriginalPublish: () => setWorkingCopyOriginalPath(
                    normalizedWorkingPath,
                    targetPath,
                    context.senderId,
                ),
                syncWorkingCopy: () => copyFileAtomic(targetPath, normalizedWorkingPath, {linkImmutableSource: true}),
                onWorkingCopySyncFailure: syncError => markSaveAsWorkingCopySyncRequired(
                    normalizedWorkingPath,
                    targetPath,
                    context.senderId,
                    syncError,
                ),
            });
            replaced = transition !== null;
        } finally {
            if (!replaced) {
                await rm(tempPath, { force: true }).catch(() => undefined);
            }
        }
    });

    allowOpenPath(targetPath, context.sender);
    await addRecentFile(targetPath);
    updateRecentFilesMenu();

    return requireDocumentRef(targetPath);
}

export async function savePdfDataAs(
    context: IDocumentsDialogContext,
    workingPath: string,
    data: unknown,
    options: IPdfSaveAsOptions | undefined,
    showSaveDialogWithExtension: TShowSaveDialogWithExtension,
    serializedSaveOptions?: IPdfSerializedSaveOptions,
): Promise<IPdfSaveAsResult> {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        return {
            path: null,
            validation: null,
        };
    }

    const payload = normalizeIpcWritePayload(data);
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }
    if (!existsSync(normalizedWorkingPath)) {
        throw new Error(`File not found: ${normalizedWorkingPath}`);
    }
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(serializedSaveOptions);

    const targetPath = await promptForPdfSaveAsTarget(
        context,
        normalizedWorkingPath,
        showSaveDialogWithExtension,
    );
    if (!targetPath) {
        return {
            path: null,
            validation: null,
        };
    }

    const tempPath = makeSiblingTempPath(targetPath);
    let replaced = false as boolean;
    try {
        await writeFile(tempPath, payload);
        const validation = await validatePdfFile(tempPath);
        if (!validation.isValid) {
            return {
                path: null,
                validation,
            };
        }
        const optimizedValidation = await optimizePdfForSaveAs(tempPath, options);
        const committedValidation = optimizedValidation ?? validation;
        const resultRef: {current: IPdfSaveAsResult | null} = { current: null };

        await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
                throw new Error('Working copy path is not managed');
            }
            await assertQueuedWorkingCopyMutationPreconditions(
                normalizedWorkingPath,
                expectedDocumentRevisionToken,
            );
            if (!existsSync(normalizedWorkingPath)) {
                throw new Error(`File not found: ${normalizedWorkingPath}`);
            }
            let warning: IPdfSaveAsWarning | undefined;
            const transition = await transitionOriginalAndWorkingCopyRevision({
                workingCopyPath: normalizedWorkingPath,
                originalPath: targetPath,
                reason: 'save-sync',
                senderId: context.senderId,
                allowMissingOriginalWitness: true,
                preservePublishedOriginalOnWorkingCopySyncFailure: true,
                useDestinationWitnessForPublication: false,
                captureOriginalWitness: () => capturePathSaveWitness(targetPath),
                publishOriginal: async assertDestinationCurrent => {
                    await commitPdfTempFile(
                        tempPath,
                        targetPath,
                        {
                            ownerId: `pdf-data-save-as:${context.senderId}`,
                            ...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent}),
                        },
                    );
                },
                afterOriginalPublish: () => setWorkingCopyOriginalPath(
                    normalizedWorkingPath,
                    targetPath,
                    context.senderId,
                ),
                syncWorkingCopy: () => copyFileAtomic(targetPath, normalizedWorkingPath, {linkImmutableSource: true}),
                onWorkingCopySyncFailure: syncError => markSaveAsWorkingCopySyncRequired(
                    normalizedWorkingPath,
                    targetPath,
                    context.senderId,
                    syncError,
                ),
            });
            replaced = transition !== null;
            if (transition && 'workingCopyRefreshed' in transition && !transition.workingCopyRefreshed) {
                warning = createWorkingCopySyncWarning(transition.workingCopySyncError);
            }
            allowOpenPath(targetPath, context.sender);
            await addRecentFile(targetPath);
            updateRecentFilesMenu();
            resultRef.current = {
                path: requireDocumentRef(targetPath),
                validation: committedValidation,
                ...(warning === undefined ? {} : {warning}),
            };
        });

        return resultRef.current ?? {
            path: null,
            validation: committedValidation,
        };
    } finally {
        if (!replaced) {
            await rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
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
