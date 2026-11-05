import type {Ref} from 'vue';
import type {
    IDocumentsBatchProgress,
    IOpenPdfResult,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import {
    combinePdfFiles,
    CombinePdfError,
    isCombineCancellationSupported,
} from '@app/services/pdf/combinePdfFiles';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import {
    releaseDocumentOpenWorkingCopyRetention,
    retainDocumentOpenWorkingCopyForRetry,
} from '@app/modules/workspace-shell/public/documentOpenWorkingCopyRetention';
import {removeCompletedCombineSnapshot} from '@app/services/pdf/removeCompletedCombineSnapshot';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {TTranslateFn} from '@i18n-app';
import {BrowserLogger} from '@app/utils/browserLogger';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    isPdfStructurePreservationRefusal,
} from '@contracts/nativeErrors';
import {DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA} from '@contracts/documentOpenErrors';
import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {hasElectronAPI} from '@app/utils/platform';

export const useCombinePdfOperation = <T extends {
    id: string;
    file: File;
    name: string
}>(options: {
    files: Ref<T[]>;
    openResult?: (result: TOpenFileResult) => Promise<boolean>;
    emitOpenResult: (result: TOpenFileResult) => void;
    translate: TTranslateFn;
}) => {
    const {
        files,
        translate,
    } = options;
    // `combining` builds the PDF; `opening` hands the result to a tab and
    // cannot be canceled from here.
    const phase = ref<'idle' | 'combining' | 'opening'>('idle');
    const isCombining = computed(() => phase.value !== 'idle');
    const progress = ref<IDocumentsBatchProgress | null>(null);
    const combineError = ref<string | null>(null);
    const combineFailure = ref<FailureReceipt | null>(null);
    const combineErrorIsExpected = ref(false);
    const pendingCombinedResult = ref<IOpenPdfResult | null>(null);
    let abortController: AbortController | null = null;

    async function combine() {
        if (!files.value.length || isCombining.value) {
            return;
        }
        const snapshot = Object.freeze(files.value.map(file => Object.freeze({...file})));
        phase.value = pendingCombinedResult.value ? 'opening' : 'combining';
        abortController = new AbortController();
        clearError();
        progress.value = {
            processed: 0,
            total: snapshot.length,
            percent: 0,
            elapsedMs: 0,
            estimatedRemainingMs: null,
        };
        try {
            const result = pendingCombinedResult.value ?? await combinePdfFiles({
                files: snapshot,
                outputName: snapshot.length === 1
                    ? snapshot[0]!.name.replace(/\.[^.]+$/u, '.pdf')
                    : `combined-${Date.now()}.pdf`,
                openErrorMessage: translate('errors.file.open'),
                onProgress: next => { progress.value = next; },
                signal: abortController.signal,
            });
            if (result.kind !== 'pdf') {
                throw new Error('ERR_COMBINE_RESULT_OPEN_FAILED');
            }
            pendingCombinedResult.value = result;
            // A failed open must leave the combined file for Retry and Save As;
            // this page removes it once the result is no longer pending.
            retainDocumentOpenWorkingCopyForRetry(result);
            phase.value = 'opening';
            if (options.openResult && !await options.openResult(result)) throw new Error('ERR_COMBINE_RESULT_OPEN_FAILED');
            if (!options.openResult) options.emitOpenResult(result);
            // The opened document now owns the working copy.
            releaseDocumentOpenWorkingCopyRetention(result);
            pendingCombinedResult.value = null;
            files.value = removeCompletedCombineSnapshot(files.value, snapshot);
        } catch (error) {
            const expected = error instanceof CombinePdfError && error.code !== 'open-failed';
            combineErrorIsExpected.value = expected;
            if (error instanceof CombinePdfError && error.code === 'canceled') return;
            if (!expected) {
                combineFailure.value = (error instanceof CombinePdfError ? error.failure : null)
                    ?? BrowserLogger.error('pdf-combine', 'PDF combine controller failed', error, {code: 'RENDERER_PDF_COMBINE_OPERATION_FAILED'});
            }
            const envelope = expected && findSerializableErrorEnvelope(error.cause, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA);
            combineError.value = isPdfStructurePreservationRefusal(error)
                ? translate('errors.pdfStructurePreservation')
                : expected
                    ? envelope && envelope.code === 'browser-byte-limit' && envelope.maxBytes !== undefined
                        ? translate('errors.browser.documentTooLarge', {limitMiB: Math.round(envelope.maxBytes / (1024 * 1024))})
                        : !hasElectronAPI() && findSerializableErrorEnvelope(error.cause, NATIVE_ERROR_ENVELOPE_SCHEMA)?.code === 'too-large'
                            ? translate('errors.browser.notEnoughMemory')
                            : translate('errors.file.invalid')
                    : translate(phase.value === 'opening' ? 'errors.file.open' : 'combinePdf.combineFailed');
        } finally {
            progress.value = null;
            abortController = null;
            phase.value = 'idle';
            // A page closed while this ran can no longer offer Retry or Save
            // As: what is still pending is let go. An opened result is not.
            if (disposed) releasePendingResult();
        }
    }

    function cancel() {
        abortController?.abort(new DOMException('PDF combine was canceled.', 'AbortError'));
    }

    async function savePendingAs() {
        const pending = pendingCombinedResult.value;
        if (!pending || isCombining.value) {
            return;
        }
        // Discarded or replaced since: not this save's.
        const replaced = () => pendingCombinedResult.value !== pending;
        try {
            const documentFiles = getDocumentFilesCapability();
            const {token} = await documentFiles.getDocumentRevision(pending.workingPath);
            const savedPath = await documentFiles.savePdfAs(pending.workingPath, undefined, {expectedDocumentRevisionToken: token});
            if (replaced() || isCombining.value) return;
            if (savedPath) discardPendingResult();
        } catch (error) {
            if (replaced()) return;
            combineError.value = translate('errors.file.save');
            combineErrorIsExpected.value = false;
            combineFailure.value = BrowserLogger.error(
                'pdf-combine',
                'Saving the combined PDF failed',
                error,
                {code: 'RENDERER_PDF_COMBINE_OPERATION_FAILED'},
            );
        }
    }

    // The pending result's working copy belongs to this page until a tab
    // opens it; letting go of the result removes the file.
    function releasePendingResult() {
        const pending = pendingCombinedResult.value;
        pendingCombinedResult.value = null;
        if (!pending) {
            return;
        }
        releaseDocumentOpenWorkingCopyRetention(pending);
        void getDocumentWorkingCopyCapability().cleanupFile(pending.workingPath).catch((error: unknown) => {
            BrowserLogger.warn('pdf-combine', 'Failed to remove a released combined PDF', {error});
        });
    }

    function clearError() {
        combineError.value = null;
        combineFailure.value = null;
        combineErrorIsExpected.value = false;
    }

    function discardPendingResult() {
        releasePendingResult();
        clearError();
    }

    let disposed = false;
    onScopeDispose(() => {
        disposed = true;
        if (!isCombining.value) {
            releasePendingResult();
        }
    });

    return {
        phase,
        isCombining,
        progress,
        combineError,
        combineFailure,
        combineErrorIsExpected,
        pendingCombinedResult,
        queueMutationLocked: computed(() => isCombining.value || pendingCombinedResult.value !== null),
        canCancel: ref(isCombineCancellationSupported()),
        combine,
        cancel,
        savePendingAs,
        discardPendingResult,
    };
};
