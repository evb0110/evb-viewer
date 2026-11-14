import type {TDocumentRef} from '@contracts/documentRef';
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
    storeFileHandle,
} from '@app/platform/browser/browserPublication';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import {
    downloadBrowserBytes,
    downloadBrowserDocument,
    ensureFileHandleWritePermission,
    pickSaveTarget,
    writeBytesToHandle,
    writeDocumentRefToHandle,
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
import {
    analyzeBrowserPdfConformanceData, validateBrowserPdfData, validateBrowserPdfPath,
} from '@app/platform/browser-api/browserPdfValidation';
import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import {copyScanCleanupDocumentPreferences} from '@app/utils/browserScanCleanupPreferences';

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
        if (target.canceled) return false;
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
    if (result.status === 'conflict') throw new BrowserDocumentSourceChangedError(sourceRef ?? workingCopyPath);
    if (result.status === 'needs-save-as') throw new Error('The document has no file to save to; use Save As.');
    if (result.status !== 'saved') throw new Error('The document changed while it was being saved');
    // A picked file takes the source's place, so Recent Files and the next open find it. Without one, the
    // stored copy Recent Files reopens takes the downloaded bytes.
    if (picked && sourceRef) await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {fileSize: 0, saveHandle: picked, saveName: picked.name});
    const source = sourceRef ? await browserDocumentStore.ensureEntry(sourceRef).catch(() => null) : null;
    if (source?.doc && !source.saveHandle && entry.doc?.state().destination?.startsWith('download:')) {
        await browserDocumentStore.replaceContent(source.ref, workingCopyPath);
    }
    if (sourceRef) await browserDocumentStore.touchRecentFile(sourceRef).catch(() => undefined);
    if (source?.doc) browserDocumentStore.unload(source.ref);
    return browserDocumentStore.getDocumentRevision(workingCopyPath);
}

export async function saveWorkingBytesToSourceStructured(
    workingCopyPath: TDocumentRef,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<TDocumentSaveResult> {
    try {
        const saved = await saveWorkingBytesToSource(workingCopyPath, revisionOptions);
        return saved
            ? {validation: null, ok: true, externalWriteCommitted: true, workingCopyRefreshed: true, documentRevision: saved}
            : {validation: null, ok: false, reason: 'user-canceled', externalWriteCommitted: false};
    } catch (error) {
        return {
            ok: false,
            message: getErrorMessage(error),
            validation: null,
            reason: error instanceof BrowserDocumentSourceChangedError ? 'original-changed' : 'write-failed',
            externalWriteCommitted: false,
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
    await browserDocumentStore.assertDocumentRevisionCurrent(workingCopyPath, revisionOptions?.expectedDocumentRevisionToken);
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
    let published: Uint8Array | Blob | undefined = staged?.bytes ?? appendedContent ?? undefined;
    if (!publication) {
        const sourcePath = staged?.artifact.path ?? workingCopyPath;
        const size = appendedContent?.size ?? (await browserDocumentStore.stat(sourcePath)).size;
        const source = staged?.bytes ?? (size > BROWSER_QPDF_MAX_INPUT_BYTES ? null
            : appendedContent ? new Uint8Array(await appendedContent.arrayBuffer())
                : await browserDocumentStore.read(sourcePath, {maxBytes: BROWSER_QPDF_MAX_INPUT_BYTES}));
        // A larger native edit was checked by the engine that appended it.
        const validation = source
            ? await validateBrowserPdfData(source, {fileName: saveTarget.saveName})
            : appendedContent ? null : await validateBrowserPdfPath(sourcePath);
        if (validation && !validation.isValid) throw new Error('Working copy is not a valid PDF');
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
    await browserDocumentStore.assertDocumentRevisionCurrent(workingCopyPath, revisionOptions?.expectedDocumentRevisionToken);
    if (saveResult.handle) {
        if (published) await writeBytesToHandle(saveResult.handle, published, signal);
        else await writeDocumentRefToHandle(saveResult.handle, workingCopyPath);
    } else if (published) {
        // No handle means no save picker: the file goes out as a download.
        downloadBrowserBytes(published, fileName, 'application/pdf', signal);
    } else {
        await downloadBrowserDocument(workingCopyPath, fileName, 'application/pdf');
    }
    // The file is published. A picked file is opened through its handle; a downloaded one keeps a stored copy
    // for Recent Files.
    const sourceRef = await browserDocumentStore.createStoredDocument(fileName, published ?? new Uint8Array(), {
        mimeType: 'application/pdf',
        saveKind: 'pdf',
        kind: 'source',
        saveHandle: saveResult.handle,
        ...(saveResult.handle ? {storageMode: 'handle' as const} : {}),
        ...(!saveResult.handle && !published ? {contentFrom: workingCopyPath} : {}),
    });
    // The browser keys Scan Cleanup settings by document, so the saved file takes them before the workspace
    // adopts it. A refused copy leaves the saved file at the defaults; the save still stands.
    try {
        await copyScanCleanupDocumentPreferences([previousSourceRef, workingCopyPath], sourceRef);
    } catch (error) {
        BrowserLogger.warn('browser-save', 'Scan Cleanup settings were not copied to the saved file', error);
    }
    await browserDocumentStore.touchRecentFile(sourceRef).catch(() => undefined);
    return sourceRef;
}
