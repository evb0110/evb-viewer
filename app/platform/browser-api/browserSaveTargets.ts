import {isAbortError} from '@contracts/isAbortError';
import type {IPendingPublish} from '@document-store/documentDirectory';
import {SavePublicationError} from '@document-store/saveDocument';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import {isRecord} from '@contracts/runtimeGuards';
import {readBrowserStoreStagedArtifact} from '@app/platform/browser/browserStagedArtifact';
import type {
    IDocumentMutationRevisionOptions,
    IPdfSaveAsOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import { BrowserDocumentSourceChangedError } from '@app/platform/browser/browserDocumentRepository';
import { browserDocumentRefId } from '@app/platform/browser/browserDocumentRefs';
import {
    downloadDestination,
    handleDestination,
    handleKeyOf,
    resolveFileHandle,
    runBrowserPublishLock,
    storeFileHandle,
} from '@app/platform/browser/browserPublication';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import {
    BrowserFileWriteOutcomeError,
    downloadBrowserBytes,
    ensureFileHandleWritePermission,
    pickSaveTarget,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import {BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES} from '@contracts/browserPageOpsLimits';
import {
    getPdfLosslessOptimizationSkipReason, PDF_LOSSLESS_OPTIMIZE_MIN_BYTES,
} from '@pdf-core/pdfConformanceHelpers';
import {
    isQpdfSuccessExitCode, QPDF_LOSSLESS_REWRITE_TIMEOUT_MS, shouldKeepPdfOptimizationCandidate,
} from '@pdf-core/qpdfCommands';
import {runBrowserQpdfCommand} from '@app/platform/browser-api/browserQpdfEngineClient';
import {repairBrowserPdfBytes} from '@app/platform/browser-api/browserWorkingCopyService';
import {
    analyzeBrowserPdfConformanceData, validateBrowserPdfData, validateBrowserPdfLoadability,
} from '@app/platform/browser-api/browserPdfValidation';
import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import {BROWSER_RECENT_FILES_STORAGE_KEY} from '@app/utils/browserRuntimePersistence';
import {copyScanCleanupDocumentPreferences} from '@app/utils/browserScanCleanupPreferences';

function warnRecentWriteFailure(documentRef: TDocumentRef, error: unknown) {
    if (isRecord(error) && (error.code === 'ENOENT' || error.name === 'NotFoundError')) {return;}
    BrowserLogger.warn('browser-save', 'Could not write Recent Files after saving', {
        key: BROWSER_RECENT_FILES_STORAGE_KEY,
        documentRef,
        error: getErrorMessage(error),
    });
}

type TBrowserSourceSaveOutcome =
    | { canceled: true }
    | {
        canceled: false;
        documentRevision: IDocumentRevisionInfo | undefined;
        refreshError?: unknown;
        pendingPublish?: IPendingPublish | undefined;
    };

async function saveWorkingBytesToSourceWithOutcome(
    workingCopyPath: TDocumentRef,
    revisionOptions?: IDocumentMutationRevisionOptions,
    commitLease?: string,
): Promise<TBrowserSourceSaveOutcome> {
    const entry = await browserDocumentStore.requireEntry(workingCopyPath);
    const destination = entry.doc?.state().destination ?? null;
    const sourceRef = entry.sourceRef ?? null;
    const key = handleKeyOf(destination);
    const handle = key === null ? null : await resolveFileHandle(key);
    let saveAs: string | undefined;
    let picked: FileSystemFileHandle | null = null;
    if (handle) {
        await ensureFileHandleWritePermission(handle);
    } else if (destination === null || !entry.doc?.state().baseline) {
        const target = await pickSaveTarget({suggestedName: ensurePdfExtension(entry.saveName), pickerTypes: buildPdfSaveTypes()});
        if (target.canceled) {return {canceled: true};}
        picked = target.handle;
        if (picked) {
            await ensureFileHandleWritePermission(picked);
            const pickedKey = browserDocumentRefId(sourceRef ?? workingCopyPath);
            await storeFileHandle(pickedKey, picked);
            saveAs = handleDestination(pickedKey);
        } else {
            saveAs = downloadDestination(ensurePdfExtension(target.fileName));
        }
    }
    const result = await browserDocumentStore.save(workingCopyPath, revisionOptions?.expectedDocumentRevisionToken, {
        ...(commitLease === undefined ? {} : {commit: commitLease}),
        ...(saveAs ? {saveAs} : {}),
    });
    if (result.status === 'conflict') {throw new BrowserDocumentSourceChangedError(sourceRef ?? workingCopyPath);}
    if (result.status === 'needs-save-as') {throw new Error('The document has no file to save to; use Save As.');}
    if (result.status !== 'saved') {throw new Error('The document changed while it was being saved');}

    let refreshError: unknown = result.acknowledgmentError;
    const recordRefreshFailure = (step: string, error: unknown) => {
        refreshError ??= error;
        BrowserLogger.warn('browser-save', `Post-publication ${step} failed after the file was saved`, {
            workingCopyPath,
            error: getErrorMessage(error),
        });
    };
    if (result.acknowledgmentError !== undefined) {
        BrowserLogger.warn('browser-save', 'Manifest acknowledgement failed after the file was saved', {
            workingCopyPath,
            hasPendingPublish: result.pendingPublish !== undefined,
            error: getErrorMessage(result.acknowledgmentError),
        });
    }
    // A picked file takes the source's place, so Recent Files and the next open find it. Without one, the
    // stored copy Recent Files reopens takes the downloaded bytes.
    if (picked && sourceRef) {
        await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {fileSize: 0, saveHandle: picked, saveName: picked.name})
            .catch((error: unknown) => recordRefreshFailure('handle adoption', error));
    }
    const source = sourceRef ? await browserDocumentStore.ensureEntry(sourceRef).catch(() => null) : null;
    const publishedDestination = saveAs ?? entry.doc?.state().destination ?? null;
    if (source?.doc && !source.saveHandle && publishedDestination?.startsWith('download:')) {
        await browserDocumentStore.replaceContent(source.ref, workingCopyPath)
            .catch((error: unknown) => recordRefreshFailure('recent copy refresh', error));
    }
    if (sourceRef) {await browserDocumentStore.touchRecentFile(sourceRef).catch((error: unknown) => warnRecentWriteFailure(sourceRef, error));}
    if (source?.doc) {browserDocumentStore.unload(source.ref);}
    let documentRevision: IDocumentRevisionInfo | undefined;
    try {
        documentRevision = await browserDocumentStore.getDocumentRevision(workingCopyPath);
    } catch (error) {
        recordRefreshFailure('revision refresh', error);
    }
    return {
        canceled: false,
        documentRevision,
        ...(refreshError === undefined ? {} : {refreshError}),
        ...(result.pendingPublish === undefined ? {} : {pendingPublish: result.pendingPublish}),
    };
}

/**
 * Save: commit the edit appended to the working copy under `commitLease`, check its file against the
 * baseline, publish. A document without a file it can check (dropped in, generated, only downloaded) picks
 * one first, the way Save As does, and keeps working on it. Write permission is asked for before the save
 * starts, so no prompt waits inside it. Returns `false` when the picker is cancelled.
 */
export async function saveWorkingBytesToSource(
    workingCopyPath: TDocumentRef,
    revisionOptions?: IDocumentMutationRevisionOptions,
    commitLease?: string,
) {
    const outcome = await saveWorkingBytesToSourceWithOutcome(workingCopyPath, revisionOptions, commitLease);
    if (outcome.canceled) {return false;}
    if (!outcome.documentRevision) {
        throw new SavePublicationError(outcome.refreshError ?? new Error('Document revision unavailable after save'), {
            externalWriteCommitted: true,
            pendingPublish: outcome.pendingPublish,
        });
    }
    return outcome.documentRevision;
}

export async function saveWorkingBytesToSourceStructured(
    workingCopyPath: TDocumentRef,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    try {
        const outcome = await saveWorkingBytesToSourceWithOutcome(workingCopyPath, revisionOptions);
        if (outcome.canceled) {
            return {validation: null, ok: false, reason: 'user-canceled', externalWriteCommitted: false};
        }
        return {
            validation: null,
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: outcome.refreshError === undefined,
            ...(outcome.documentRevision ? {documentRevision: outcome.documentRevision} : {}),
            ...(outcome.refreshError === undefined ? {} : {
                warning: {
                    reason: 'refresh-failed' as const,
                    message: getErrorMessage(outcome.refreshError),
                },
            }),
        };
    } catch (error) {
        const externalWriteCommitted = error instanceof SavePublicationError || error instanceof BrowserFileWriteOutcomeError
            ? error.externalWriteCommitted
            : false;
        return {
            ok: false,
            message: getErrorMessage(error),
            validation: null,
            reason: error instanceof BrowserDocumentSourceChangedError
                ? 'original-changed'
                : externalWriteCommitted === true ? 'refresh-failed' : 'write-failed',
            externalWriteCommitted,
        };
    }
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
        if (isAbortError(error)) {throw error;}
        return null;
    }
}

/** Ordinary Save As skips optional optimization unless strict analysis proves the PDF eligible. */
async function isEligibleForSaveAsOptimization(source: Uint8Array) {
    try {
        return getPdfLosslessOptimizationSkipReason(await analyzeBrowserPdfConformanceData(source)) === null;
    } catch (error) {
        if (isAbortError(error)) {throw error;}
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

/**
 * Save As: publishes the working copy, or the staged output that is its next state, to a picked file or a
 * download, and returns the saved file's ref. The shell opens a new working copy of that file and closes
 * this one, so this working copy is left as it is.
 */
export async function savePdfAsFromWorkingCopy(
    workingCopyPath: TDocumentRef,
    saveOptions?: IPdfSaveAsOptions,
    revisionOptions?: IDocumentMutationRevisionOptions,
    publication?: IBrowserFinalizedPublication,
): Promise<TDocumentRef | null> {
    const stagedOutput = saveOptions?.stagedOutput;
    if (stagedOutput && !revisionOptions?.expectedDocumentRevisionToken) {
        throw new Error('Browser staged Save As requires a revision-checked target');
    }
    // A native edit is appended to the working copy itself and published from there, uncommitted.
    const appended = stagedOutput?.path === workingCopyPath ? stagedOutput : undefined;
    if (publication && !stagedOutput) {
        throw new Error('Browser finalized Save As requires a staged output');
    }
    const signal = publication?.signal;
    const expected = {token: revisionOptions?.expectedDocumentRevisionToken};
    const revisionCheckOptions = appended ? {allowStagedBase: true} : {allowStagedBase: false};
    await browserDocumentStore.assertDocumentRevisionCurrent(workingCopyPath, expected.token, revisionCheckOptions);
    const saveTarget = await browserDocumentStore.getSaveTarget(workingCopyPath);
    const previousSourceRef = publication?.sourceRef ?? await browserDocumentStore.getSourceRef(workingCopyPath);
    const saveResult = publication?.target ?? await pickSaveTarget({
        suggestedName: ensurePdfExtension(saveTarget.saveName),
        pickerTypes: buildPdfSaveTypes(),
    });
    if (saveResult.canceled) {
        return null;
    }
    if (saveResult.handle) {
        await ensureFileHandleWritePermission(saveResult.handle, signal);
    }
    signal?.throwIfAborted();
    const staged = stagedOutput && !appended ? await readBrowserStoreStagedArtifact(
        browserDocumentStore,
        stagedOutput,
        {maxBytes: publication ? BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES : BROWSER_QPDF_MAX_INPUT_BYTES},
    ) : null;
    const appendedContent = appended ? await browserDocumentStore.appendedContent(workingCopyPath, appended.leaseId) : null;
    signal?.throwIfAborted();
    const fileName = saveResult.handle?.name ?? ensurePdfExtension(saveResult.fileName);
    // The working copy's own bytes are one revision's Blob, that of the revision checked above, read once: the
    // checks below read it, and it is what is published, never the working copy as it is by then. Retaining its
    // `instance` and refusing staged bases (`allowStagedBase: false`) ensures neither release+reopen nor a
    // concurrent foreign `stageAppend` can pass the pre-publish check, while an edit+undo back to the same
    // immutable store revision still publishes the already-checked bytes.
    const workingCopyRevision = staged || appendedContent
        ? null
        : await browserDocumentStore.readableRevision(workingCopyPath, expected);
    const input = staged ? staged.bytes : appendedContent ?? workingCopyRevision!.blob;
    const publishRevisionToken = workingCopyRevision ? workingCopyRevision.token : expected.token;
    const publishRevisionCheckOptions = workingCopyRevision
        ? {allowStagedBase: false, expectedInstance: workingCopyRevision.instance}
        : revisionCheckOptions;
    let published: Uint8Array | Blob = input;
    if (!publication) {
        const size = input instanceof Blob ? input.size : input.byteLength;
        const oversized = input instanceof Blob && size > BROWSER_QPDF_MAX_INPUT_BYTES ? input : null;
        let source = oversized ? null : input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
        // A larger native edit was checked by the engine that appended it; a larger working copy is checked by PDF.js.
        let validation = source
            ? await validateBrowserPdfData(source, {fileName: saveTarget.saveName})
            : oversized && !appendedContent ? await validateBrowserPdfLoadability(oversized) : null;
        // Damage the file already had is repaired once, by the qpdf rewrite a page edit's recovery uses.
        const repaired = source && validation?.isValid === false
            ? await repairBrowserPdfBytes(source).catch(() => null)
            : null;
        if (repaired) {
            source = repaired;
            published = repaired;
            validation = await validateBrowserPdfData(repaired, {fileName: saveTarget.saveName});
        }
        if (validation && !validation.isValid) {throw new Error('Working copy is not a valid PDF');}
        const candidate = source
            && (saveOptions?.optimizeLossless === true || size >= PDF_LOSSLESS_OPTIMIZE_MIN_BYTES)
            && await isEligibleForSaveAsOptimization(source)
            ? await finishBrowserPdfCandidate(source, {fileName})
            : null;
        // Unchanged bytes keep the streaming path, even after an admitted check.
        published = candidate ?? published;
    }
    signal?.throwIfAborted();
    // The picker and the checks above take time; an edit made meanwhile is not in this frontier.
    if (saveResult.handle) {
        // The picked file may be one another document saves to; its write waits for that Save's check and hash. An
        // edit that lands while it waits is not in this frontier either.
        const {handle} = saveResult;
        const bytes = published;
        await runBrowserPublishLock(async () => {
            await browserDocumentStore.assertDocumentRevisionCurrent(workingCopyPath, publishRevisionToken, publishRevisionCheckOptions);
            await writeBytesToHandle(handle, bytes, signal);
        }, signal);
    } else {
        await browserDocumentStore.assertDocumentRevisionCurrent(workingCopyPath, publishRevisionToken, publishRevisionCheckOptions);
        // No handle means no save picker: the file goes out as a download.
        downloadBrowserBytes(published, fileName, 'application/pdf', signal);
    }
    // The file is published. A picked file is opened through its handle; a downloaded one keeps a stored copy
    // for Recent Files.
    let sourceRef: TDocumentRef;
    try {
        sourceRef = await browserDocumentStore.createStoredDocument(fileName, published, {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'source',
            saveHandle: saveResult.handle,
            ...(saveResult.handle ? {storageMode: 'handle' as const} : {}),
        });
    } catch (error) {
        const adoptionError = new Error(
            `Saved copy "${fileName}" was written, but browser document adoption failed: ${getErrorMessage(error)}`,
            {cause: error},
        );
        throw new BrowserFileWriteOutcomeError(adoptionError, true);
    }
    // The browser keys Scan Cleanup settings by document, so the saved file takes them before the workspace
    // adopts it. A refused copy leaves the saved file at the defaults; the save still stands.
    try {
        await copyScanCleanupDocumentPreferences([previousSourceRef, workingCopyPath], sourceRef);
    } catch (error) {
        BrowserLogger.warn('browser-save', 'Scan Cleanup settings were not copied to the saved file', error);
    }
    await browserDocumentStore.touchRecentFile(sourceRef).catch((error: unknown) => warnRecentWriteFailure(sourceRef, error));
    return sourceRef;
}
