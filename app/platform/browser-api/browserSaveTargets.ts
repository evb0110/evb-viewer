import type {TDocumentRef} from '@contracts/documentRef';
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
    downloadBrowserDocument,
    ensureFileHandleWritePermission,
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeDocumentRefToHandle,
    writeBytesToHandleInSaveLock,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    reserveBrowserDocumentWorkingCopy, retireBrowserDocumentWorkingCopy,
    handoffBrowserDocumentWorkingCopy,
} from '@app/platform/browserWindowTabs';
import { getErrorMessage } from '@app/utils/error';

export class BrowserExternalSaveSyncRequiredError extends Error {
    public readonly externalWriteCommitted: boolean | null;

    public constructor(cause: unknown, externalWriteCommitted: boolean | null = true) {
        super(`Saved the browser document externally, but failed to refresh local save bookkeeping: ${getErrorMessage(cause)}`);
        this.name = 'BrowserExternalSaveSyncRequiredError';
        this.externalWriteCommitted = externalWriteCommitted;
    }
}

export async function assertBrowserPathWithinFullReadBudget(
    path: string,
    label: string,
    hint?: string,
    maxBytes = BROWSER_MAX_FULL_READ_BYTES,
) {
    const { size } = await browserDocumentStore.stat(path);
    if (size > maxBytes) {
        throw buildBrowserByteLimitError(label, maxBytes, 'inputs', hint);
    }
}

export async function saveWorkingBytesToSource(
    workingCopyPath: TDocumentRef,
    revisionOptions?: IDocumentMutationRevisionOptions,
    stagedOutput?: ITypedStagedArtifact,
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
    // A stored handle may need its write permission re-granted, which shows a
    // browser prompt. Ask before the origin-wide save lock, so the prompt does
    // not hold up other windows' saves. The write inside the lock never prompts.
    if (pickedTarget.handle) {
        await ensureFileHandleWritePermission(pickedTarget.handle);
    }
    let externalWriteCommitted: boolean | null = false;

    try {
        return await browserDocumentStore.runDocumentMutationWithSource(
            workingCopyPath,
            sourceRef,
            revisionOptions?.expectedDocumentRevisionToken,
            async (mutation) => {
                const staged = stagedOutput ? await readBrowserStoreStagedArtifact(
                    browserDocumentStore,
                    stagedOutput,
                ) : null;
                if (staged?.artifact.path === workingCopyPath) throw new Error('Browser staged commit requires a different target ref');
                if (pickedTarget.handle) {
                    await mutation.assertPhysicalSourceBaseCurrent();
                    if (staged) await writeBytesToHandleInSaveLock(pickedTarget.handle, staged.bytes);
                    else await writeDocumentRefToHandle(pickedTarget.handle, workingCopyPath);
                    externalWriteCommitted = true;
                    const size = staged?.bytes.byteLength ?? (await browserDocumentStore.stat(workingCopyPath)).size;
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
                    // No handle means no save picker: the file goes out as a download.
                    const fileName = ensurePdfExtension(pickedTarget.fileName);
                    if (staged) {
                        const saveResult = await saveBytesToPickerOrDownload(staged.bytes, {
                            suggestedName: fileName,
                            mimeType: 'application/pdf',
                            pickerTypes: buildPdfSaveTypes(),
                        });
                        if (saveResult.canceled) {
                            return false;
                        }
                        externalWriteCommitted = true;
                        await mutation.writeSource(staged.bytes);
                    } else {
                        await downloadBrowserDocument(workingCopyPath, fileName, 'application/pdf');
                        externalWriteCommitted = true;
                        await mutation.writeSourceFromDocument();
                    }
                    await browserDocumentStore.assignSaveTarget(sourceRef, fileName, 'pdf', null);
                }

                // The base advances only here, once the physical file has been
                // written and the target it was written to is the one the source
                // record points at. Skipping it on the picker branch left the
                // working copy describing the file it no longer saves to, so the
                // next ordinary Save reported our own write as an external edit.
                if (staged) await mutation.write(staged.bytes);
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
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    try {
        const saved = await saveWorkingBytesToSource(
            workingCopyPath,
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
    // Same as saveWorkingBytesToSource: the permission prompt runs before the
    // origin-wide save lock, and the write inside it never prompts.
    if (saveResult.handle) {
        await ensureFileHandleWritePermission(saveResult.handle);
    }
    let externalWriteCommitted: boolean | null = false;
    try {
        return await browserDocumentStore.runDocumentMutationWithSource(
            workingCopyPath,
            previousSourceRef,
            revisionOptions?.expectedDocumentRevisionToken,
            async () => {
                const staged = stagedOutput ? await readBrowserStoreStagedArtifact(
                    browserDocumentStore,
                    stagedOutput,
                ) : null;
                const normalizedFileName = ensurePdfExtension(saveResult.fileName);
                const savedHandle = saveResult.handle;
                if (savedHandle) {
                    if (staged) await writeBytesToHandleInSaveLock(savedHandle, staged.bytes);
                    else await writeDocumentRefToHandle(savedHandle, workingCopyPath);
                } else if (staged) {
                    // No handle means no save picker: the file goes out as a download.
                    const downloadResult = await saveBytesToPickerOrDownload(staged.bytes, {
                        suggestedName,
                        mimeType: 'application/pdf',
                        pickerTypes: buildPdfSaveTypes(),
                    });
                    if (downloadResult.canceled) return null;
                } else {
                    await downloadBrowserDocument(workingCopyPath, normalizedFileName, 'application/pdf');
                }
                externalWriteCommitted = true;
                const sourceRef = await reserveBrowserDocumentWorkingCopy(normalizedFileName);
                try {
                    // A downloaded copy's record is created holding its bytes, so
                    // peer collection never sees an empty committed target.
                    await browserDocumentStore.createStoredDocument(normalizedFileName, savedHandle ? new Uint8Array() : staged?.bytes ?? new Uint8Array(), {
                        ref: sourceRef,
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'source',
                        saveHandle: savedHandle,
                        ...(savedHandle ? {storageMode: 'handle' as const} : {}),
                        ...(!savedHandle && !staged ? {contentFrom: workingCopyPath} : {}),
                    });
                    if (savedHandle) {
                        await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                            fileSize: staged?.bytes.byteLength ?? (await browserDocumentStore.stat(workingCopyPath)).size,
                            saveHandle: savedHandle,
                            saveName: normalizedFileName,
                        });
                    }
                    handoffBrowserDocumentWorkingCopy(sourceRef, workingCopyPath, () => browserDocumentStore.touchRecentFile(sourceRef));
                    return sourceRef;
                } catch (error) {
                    await retireBrowserDocumentWorkingCopy(sourceRef);
                    throw error;
                }
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
