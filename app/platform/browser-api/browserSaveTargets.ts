import type {TDocumentRef} from '@contracts/documentRef';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {readBrowserStoreStagedArtifact} from '@app/platform/browser/browserStagedArtifact';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSaveAsOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import {
    BrowserFileWriteOutcomeError,
    downloadBrowserBytes,
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
import {BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import {BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES} from '@contracts/browserPageOpsLimits';
import {
    getPdfLosslessOptimizationSkipReason, PDF_LOSSLESS_OPTIMIZE_MIN_BYTES,
} from '@pdf-core/pdfConformanceHelpers';
import {
    isQpdfSuccessExitCode, QPDF_LOSSLESS_REWRITE_TIMEOUT_MS, shouldKeepPdfOptimizationCandidate,
} from '@pdf-core/qpdfCommands';
import {runBrowserQpdfCommand} from '@app/platform/browser-api/browserQpdfEngineClient';
import {
    analyzeBrowserPdfConformanceData, validateBrowserPdfData, validateBrowserPdfPath,
} from '@app/platform/browser-api/browserPdfValidation';
import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import {copyScanCleanupDocumentPreferences} from '@app/utils/browserScanCleanupPreferences';

export class BrowserExternalSaveSyncRequiredError extends Error {
    public readonly externalWriteCommitted: boolean | null;

    public constructor(cause: unknown, externalWriteCommitted: boolean | null = true) {
        super(`Saved the browser document externally, but failed to refresh local save bookkeeping: ${getErrorMessage(cause)}`);
        this.name = 'BrowserExternalSaveSyncRequiredError';
        this.externalWriteCommitted = externalWriteCommitted;
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
            fileName: saveTarget.saveHandle.name,
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
                if (pickedTarget.handle) await mutation.assertPhysicalSourceBaseCurrent();
                // The open copy keeps the base its unsaved edits describe until
                // their bytes go in last, even once the source becomes the saved file.
                if (staged) await mutation.materializeWorkingCopy();
                if (pickedTarget.handle) {
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
                await mutation.acknowledgePhysicalSourceCommit();
                await browserDocumentStore.touchRecentFile(sourceRef);
                // The authored bytes go in last, so any earlier failure leaves
                // the working copy at the base its unsaved annotations describe.
                if (staged) await mutation.write(staged.bytes);
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

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

/**
 * Desktop's structural finish: a qpdf lossless rewrite, kept only when it is
 * a nonempty, strictly smaller copy that passes its own full check. Returns
 * null to publish `input` unchanged; qpdf works on a copy, so `input` stays
 * intact. Any other failure falls back to `input`. Abort always throws.
 * Callers decide eligibility before calling.
 */
export async function finishBrowserPdfCandidate(
    input: Uint8Array,
    options: {
        fileName: string;
        signal?: AbortSignal
    },
): Promise<Uint8Array | null> {
    const {signal} = options;
    try {
        signal?.throwIfAborted();
        const result = await runBrowserQpdfCommand('lossless-rewrite', input.slice(), {
            timeoutMs: QPDF_LOSSLESS_REWRITE_TIMEOUT_MS,
            ...(signal ? {signal} : {}),
        });
        signal?.throwIfAborted();
        const candidate = result.output;
        // The cheap size gate runs before the candidate's full check.
        if (!isQpdfSuccessExitCode(result.exitCode) || !candidate?.byteLength || candidate.byteLength >= input.byteLength) {
            return null;
        }
        const validation = await validateBrowserPdfData(candidate, options);
        signal?.throwIfAborted();
        return shouldKeepPdfOptimizationCandidate(input.byteLength, candidate.byteLength, validation) ? candidate : null;
    } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error)) throw error;
        return null;
    }
}

/** Ordinary Save As skips optional optimization unless strict analysis proves the PDF eligible. */
async function isEligibleForSaveAsOptimization(source: Uint8Array) {
    try {
        return getPdfLosslessOptimizationSkipReason(await analyzeBrowserPdfConformanceData(source)) === null;
    } catch (error) {
        if (isAbortError(error)) throw error;
        return false;
    }
}

/**
 * A frontier an operation already finished and validated, with the target
 * picked during the request's user gesture. Save As publishes it as it is.
 */
export interface IBrowserFinalizedPublication {
    kind: 'finalized';
    target: Awaited<ReturnType<typeof pickSaveTarget>>;
    /** The source captured with the operation's input, never reread here. */
    sourceRef: string;
    /** Cancels until the external write commits; bookkeeping then finishes. */
    signal: AbortSignal;
}

/** Publishes the captured Save As frontier without changing the source or consuming its staging lease. */
export async function savePdfAsFromWorkingCopy(
    workingCopyPath: TDocumentRef,
    saveOptions?: IPdfSaveAsOptions,
    revisionOptions?: IDocumentMutationRevisionOptions,
    publication?: IBrowserFinalizedPublication,
): Promise<TDocumentRef | null> {
    const stagedOutput = saveOptions?.stagedOutput;
    if (stagedOutput && (!revisionOptions?.expectedDocumentRevisionToken || stagedOutput.path === workingCopyPath)) {
        throw new Error('Browser staged Save As requires a revision-checked target distinct from its output');
    }
    if (publication && !stagedOutput) {
        throw new Error('Browser finalized Save As requires a staged output');
    }
    const signal = publication?.signal;
    await browserDocumentStore.assertDocumentRevisionCurrent(
        workingCopyPath,
        revisionOptions?.expectedDocumentRevisionToken,
    );
    const saveTarget =
        await browserDocumentStore.getSaveTarget(workingCopyPath);
    const previousSourceRef = publication?.sourceRef
        ?? await browserDocumentStore.getSourceRef(workingCopyPath);
    const saveResult = publication?.target ?? await pickSaveTarget({
        suggestedName: ensurePdfExtension(saveTarget.saveName),
        pickerTypes: buildPdfSaveTypes(),
    });

    if (saveResult.canceled) {
        return null;
    }
    // Same as saveWorkingBytesToSource: the permission prompt runs before the
    // origin-wide save lock, and the write inside it never prompts.
    if (saveResult.handle) {
        await ensureFileHandleWritePermission(saveResult.handle, signal);
    }
    let externalWriteCommitted: boolean | null = false;
    try {
        return await browserDocumentStore.runDocumentMutationWithSource(
            workingCopyPath,
            previousSourceRef,
            revisionOptions?.expectedDocumentRevisionToken,
            async () => {
                signal?.throwIfAborted();
                const staged = stagedOutput ? await readBrowserStoreStagedArtifact(
                    browserDocumentStore,
                    stagedOutput,
                    {maxBytes: publication ? BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES : BROWSER_QPDF_MAX_INPUT_BYTES},
                ) : null;
                signal?.throwIfAborted();
                const normalizedFileName = saveResult.handle?.name ?? ensurePdfExtension(saveResult.fileName);
                const sourcePath = staged?.artifact.path ?? workingCopyPath;
                const {size} = await browserDocumentStore.stat(sourcePath);
                let publishedBytes = staged?.bytes;
                if (!publication) {
                    const source = staged?.bytes ?? (size <= BROWSER_QPDF_MAX_INPUT_BYTES
                        ? await browserDocumentStore.read(sourcePath, {maxBytes: BROWSER_QPDF_MAX_INPUT_BYTES}) : null);
                    const validation = source
                        ? await validateBrowserPdfData(source, {fileName: saveTarget.saveName})
                        : await validateBrowserPdfPath(sourcePath);
                    if (!validation.isValid) throw new Error('Working copy is not a valid PDF');
                    const candidate = source
                        && (saveOptions?.optimizeLossless === true || size >= PDF_LOSSLESS_OPTIMIZE_MIN_BYTES)
                        && await isEligibleForSaveAsOptimization(source)
                        ? await finishBrowserPdfCandidate(source, {fileName: normalizedFileName})
                        : null;
                    // Unchanged refs keep the shared streaming path, even after an admitted check.
                    publishedBytes = candidate ?? staged?.bytes;
                }
                signal?.throwIfAborted();
                if (saveResult.handle) {
                    if (publishedBytes) await writeBytesToHandleInSaveLock(saveResult.handle, publishedBytes, signal);
                    else await writeDocumentRefToHandle(saveResult.handle, workingCopyPath);
                } else if (publication && publishedBytes) {
                    // The picker already ran in the request's gesture; never reopen it.
                    downloadBrowserBytes(publishedBytes, normalizedFileName, 'application/pdf', signal);
                } else if (publishedBytes) {
                    // No handle means no save picker: the file goes out as a download.
                    const downloadResult = await saveBytesToPickerOrDownload(publishedBytes, {
                        suggestedName: normalizedFileName,
                        mimeType: 'application/pdf',
                        pickerTypes: buildPdfSaveTypes(),
                    });
                    if (downloadResult.canceled) return null;
                } else {
                    await downloadBrowserDocument(workingCopyPath, normalizedFileName, 'application/pdf');
                }
                // Committed at a successful close or a dispatched download. The
                // bookkeeping below finishes even if the request aborts now.
                externalWriteCommitted = true;
                const sourceRef = await reserveBrowserDocumentWorkingCopy(normalizedFileName);
                try {
                    // A downloaded copy's record is created holding its bytes, so
                    // peer collection never sees an empty committed target.
                    await browserDocumentStore.createStoredDocument(normalizedFileName, saveResult.handle ? new Uint8Array() : publishedBytes ?? new Uint8Array(), {
                        ref: sourceRef,
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'source',
                        saveHandle: saveResult.handle,
                        ...(saveResult.handle ? {storageMode: 'handle' as const} : {}),
                        ...(!saveResult.handle && !publishedBytes ? {contentFrom: workingCopyPath} : {}),
                    });
                    if (saveResult.handle) {
                        await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                            fileSize: publishedBytes?.byteLength ?? size,
                            saveHandle: saveResult.handle,
                            saveName: normalizedFileName,
                        });
                    }
                    // The browser keys Scan Cleanup settings by document, so the saved
                    // file takes them before the workspace adopts it. A refused copy
                    // leaves the saved file at the defaults; the save still stands.
                    try {
                        copyScanCleanupDocumentPreferences([
                            previousSourceRef,
                            workingCopyPath,
                        ], sourceRef);
                    } catch (error) {
                        BrowserLogger.warn('browser-save', 'Scan Cleanup settings were not copied to the saved file', error);
                    }
                    handoffBrowserDocumentWorkingCopy(sourceRef, workingCopyPath, () => browserDocumentStore.touchRecentFile(sourceRef));
                    return sourceRef;
                } catch (error) {
                    await retireBrowserDocumentWorkingCopy(sourceRef);
                    throw error;
                }
            },
            signal ? {signal} : {},
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
