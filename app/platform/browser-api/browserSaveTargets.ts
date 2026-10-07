import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {readBrowserStoreStagedArtifact} from '@app/platform/browser/browserStagedArtifact';
import type {
    IDocumentMutationRevisionOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import { buildBrowserByteLimitError } from '@app/platform/browser-api/browserPlatformHelpers';
import {
    BrowserFileWriteOutcomeError,
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeDocumentRefToHandle,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import { getErrorMessage } from '@app/utils/error';

export class BrowserExternalSaveSyncRequiredError extends Error {
    public readonly externalWriteCommitted: boolean | null;

    public constructor(cause: unknown, externalWriteCommitted: boolean | null = true) {
        super(`Saved the browser document externally, but failed to refresh local save bookkeeping: ${getErrorMessage(cause)}`);
        this.name = 'BrowserExternalSaveSyncRequiredError';
        this.externalWriteCommitted = externalWriteCommitted;
    }
}

function buildBrowserLargeJobError(
    label: string,
    maxBytes: number,
    hint?: string,
) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
        hint,
    );
}

export async function assertBrowserPathWithinFullReadBudget(
    path: string,
    label: string,
    hint?: string,
) {
    const { size } = await browserDocumentStore.stat(path);
    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        throw buildBrowserLargeJobError(label, BROWSER_MAX_FULL_READ_BYTES, hint);
    }
}

export async function saveWorkingBytesToSource(
    workingCopyPath: TDocumentRef,
    getBrowserLargeSaveHandleHint: () => string,
    revisionOptions?: IDocumentMutationRevisionOptions,
) {
    const sourceRef = await browserDocumentStore.getSourceRef(workingCopyPath);
    const saveTarget = await browserDocumentStore.getSaveTarget(sourceRef);
    const pickedTarget = saveTarget.saveHandle
        ? {
            canceled: false,
            fileName: saveTarget.saveName,
            handle: saveTarget.saveHandle,
        }
        : await pickSaveTarget({
            suggestedName: ensurePdfExtension(saveTarget.saveName),
            pickerTypes: buildPdfSaveTypes(),
        });
    if (pickedTarget.canceled) {
        return false;
    }
    let externalWriteCommitted: boolean | null = false;

    try {
        return await browserDocumentStore.runDocumentMutationWithSource(
            workingCopyPath,
            sourceRef,
            revisionOptions?.expectedDocumentRevisionToken,
            async (mutation) => {
                if (pickedTarget.handle) {
                    await mutation.assertPhysicalSourceBaseCurrent();
                    await writeDocumentRefToHandle(pickedTarget.handle, workingCopyPath);
                    externalWriteCommitted = true;
                    const { size } = await browserDocumentStore.stat(workingCopyPath);
                    await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                        fileSize: size,
                        saveHandle: pickedTarget.handle,
                        saveName: pickedTarget.fileName,
                    });
                    await browserDocumentStore.assignSaveTarget(
                        sourceRef,
                        pickedTarget.fileName,
                        saveTarget.saveKind,
                        pickedTarget.handle,
                    );
                } else {
                    await assertBrowserPathWithinFullReadBudget(
                        workingCopyPath,
                        'Saving documents',
                        getBrowserLargeSaveHandleHint(),
                    );
                    const bytes = await browserDocumentStore.read(workingCopyPath);
                    const saveResult = await saveBytesToPickerOrDownload(bytes, {
                        suggestedName: ensurePdfExtension(pickedTarget.fileName),
                        mimeType: 'application/pdf',
                        pickerTypes: buildPdfSaveTypes(),
                        downloadFallbackLabel: 'Saving documents',
                    });

                    if (saveResult.canceled) {
                        return false;
                    }

                    externalWriteCommitted = true;
                    await mutation.writeSource(bytes);
                    await browserDocumentStore.assignSaveTarget(
                        sourceRef,
                        ensurePdfExtension(saveResult.fileName),
                        'pdf',
                        saveResult.handle,
                    );
                }

                // The base advances only here, once the physical file has been
                // written and the target it was written to is the one the source
                // record points at. Skipping it on the picker branch left the
                // working copy describing the file it no longer saves to, so the
                // next ordinary Save reported our own write as an external edit.
                await mutation.acknowledgePhysicalSourceCommit();
                await browserDocumentStore.touchRecentFile(sourceRef);
                return true;
            },
        );
    } catch (error) {
        if (error instanceof BrowserFileWriteOutcomeError) {
            externalWriteCommitted = error.externalWriteCommitted;
        }
        if (externalWriteCommitted !== false) {
            throw new BrowserExternalSaveSyncRequiredError(error, externalWriteCommitted);
        }
        throw error;
    }
}

export async function saveWorkingBytesToSourceStructured(
    workingCopyPath: TDocumentRef,
    getBrowserLargeSaveHandleHint: () => string,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    try {
        const saved = await saveWorkingBytesToSource(
            workingCopyPath,
            getBrowserLargeSaveHandleHint,
            revisionOptions,
        );
        if (!saved) {
            return {
                ok: false,
                reason: 'user-canceled',
                externalWriteCommitted: false,
                validation: null,
            };
        }
        return {
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        };
    } catch (error) {
        if (error instanceof BrowserExternalSaveSyncRequiredError) {
            return {
                ok: false,
                reason: 'working-copy-sync-required',
                message: error.message,
                externalWriteCommitted: error.externalWriteCommitted,
                workingCopySyncRequired: true,
                validation: null,
            };
        }
        return {
            ok: false,
            reason: 'write-failed',
            message: getErrorMessage(error),
            externalWriteCommitted: false,
            validation: null,
        };
    }
}

/** Publishes the captured Save As frontier without changing the source or consuming its staging lease. */
export async function savePdfAsFromWorkingCopy(
    workingCopyPath: TDocumentRef,
    revisionOptions?: IDocumentMutationRevisionOptions,
    stagedOutput?: ITypedStagedArtifact,
    useNativeAppMessage?: string,
) {
    if (stagedOutput && (!revisionOptions?.expectedDocumentRevisionToken || stagedOutput.path === workingCopyPath)) {
        throw new Error('Browser staged Save As requires a revision-checked target distinct from its output');
    }
    await browserDocumentStore.assertDocumentRevisionCurrent(
        workingCopyPath,
        revisionOptions?.expectedDocumentRevisionToken,
    );
    const saveTarget =
        await browserDocumentStore.getSaveTarget(workingCopyPath);
    const previousSourceRef =
        await browserDocumentStore.getSourceRef(workingCopyPath);
    const suggestedName = ensurePdfExtension(saveTarget.saveName);
    const saveResult = await pickSaveTarget({
        suggestedName,
        pickerTypes: buildPdfSaveTypes(),
    });

    if (saveResult.canceled) {
        return null;
    }
    let externalWriteCommitted: boolean | null = false;
    let savedSourceRef: TDocumentRef | null;
    try {
        const savedSourceRefResult = await browserDocumentStore.runDocumentMutationWithSource(
            workingCopyPath,
            previousSourceRef,
            revisionOptions?.expectedDocumentRevisionToken,
            async (mutation) => {
                const staged = stagedOutput ? await readBrowserStoreStagedArtifact(browserDocumentStore, stagedOutput) : null;
                let normalizedFileName = ensurePdfExtension(saveResult.fileName);
                let savedHandle = saveResult.handle;
                let sourceRef: TDocumentRef;

                if (saveResult.handle) {
                    if (staged) await writeBytesToHandle(saveResult.handle, staged.bytes);
                    else await writeDocumentRefToHandle(saveResult.handle, workingCopyPath);
                    externalWriteCommitted = true;
                    const size = staged?.bytes.byteLength ?? (await browserDocumentStore.stat(workingCopyPath)).size;
                    sourceRef = await browserDocumentStore.createStoredDocument(
                        normalizedFileName,
                        new Uint8Array(),
                        {
                            mimeType: 'application/pdf',
                            saveKind: 'pdf',
                            kind: 'source',
                            saveHandle: saveResult.handle,
                            storageMode: 'handle',
                        },
                    );
                    await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                        fileSize: size,
                        saveHandle: saveResult.handle,
                        saveName: normalizedFileName,
                    });
                    await browserDocumentStore.assignSaveTarget(
                        sourceRef,
                        normalizedFileName,
                        'pdf',
                        saveResult.handle,
                    );
                } else {
                    if (!staged) {
                        await assertBrowserPathWithinFullReadBudget(
                            workingCopyPath,
                            'Saving documents',
                            useNativeAppMessage,
                        );
                    }
                    const bytes = staged?.bytes ?? await browserDocumentStore.read(workingCopyPath);
                    const downloadResult = await saveBytesToPickerOrDownload(bytes, {
                        suggestedName,
                        mimeType: 'application/pdf',
                        pickerTypes: buildPdfSaveTypes(),
                        downloadFallbackLabel: 'Saving documents',
                    });

                    if (downloadResult.canceled) {
                        return null;
                    }

                    externalWriteCommitted = true;
                    normalizedFileName = ensurePdfExtension(downloadResult.fileName);
                    savedHandle = downloadResult.handle;
                    sourceRef = await browserDocumentStore.createStoredDocument(
                        normalizedFileName,
                        bytes,
                        {
                            mimeType: 'application/pdf',
                            saveKind: 'pdf',
                            kind: 'source',
                            saveHandle: downloadResult.handle,
                        },
                    );
                }
                await mutation.replaceWorkingCopySource(
                    sourceRef,
                    normalizedFileName,
                    savedHandle,
                );
                await browserDocumentStore.touchRecentFile(sourceRef);
                browserDocumentStore.unload(sourceRef);
                return sourceRef;
            },
        );
        savedSourceRef = parseDocumentRef(savedSourceRefResult);
    } catch (error) {
        if (error instanceof BrowserFileWriteOutcomeError) {
            externalWriteCommitted = error.externalWriteCommitted;
        }
        if (externalWriteCommitted !== false) {
            throw new BrowserExternalSaveSyncRequiredError(error, externalWriteCommitted);
        }
        throw error;
    }

    if (
        savedSourceRef
        && savedSourceRef !== previousSourceRef
        && previousSourceRef !== workingCopyPath
    ) {
        await browserDocumentStore.cleanupDetachedDocument(previousSourceRef)
            .catch(() => undefined);
    }
    return savedSourceRef;
}
