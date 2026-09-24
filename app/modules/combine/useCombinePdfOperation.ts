import type {Ref} from 'vue';
import type {
    IDocumentsBatchProgress,
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
import {BrowserLogger} from '@app/utils/browserLogger';

export const useCombinePdfOperation = <T extends {
    id: string;
    file: File;
    name: string
}>(options: {
    files: Ref<T[]>;
    openResult?: (result: TOpenFileResult) => Promise<boolean>;
    emitOpenResult: (result: TOpenFileResult) => void;
    translate: (key: string) => string;
}) => {
    // `combining` builds the PDF; `opening` hands the result to a tab and
    // cannot be canceled from here.
    const phase = ref<'idle' | 'combining' | 'opening'>('idle');
    const isCombining = computed(() => phase.value !== 'idle');
    const progress = ref<IDocumentsBatchProgress | null>(null);
    const combineError = ref<string | null>(null);
    const combineFailure = ref<FailureReceipt | null>(null);
    const combineErrorIsExpected = ref(false);
    const pendingCombinedResult = ref<TOpenFileResult | null>(null);
    const canCancel = ref(isCombineCancellationSupported());
    const queueMutationLocked = computed(() => (
        isCombining.value || pendingCombinedResult.value !== null
    ));
    let abortController: AbortController | null = null;

    function buildOutputName(operationFiles: readonly T[]) {
        const firstFile = operationFiles[0];
        return operationFiles.length === 1 && firstFile
            ? firstFile.name.replace(/\.[^.]+$/u, '.pdf')
            : `combined-${Date.now()}.pdf`;
    }

    async function combine() {
        if (options.files.value.length === 0 || isCombining.value) {
            return;
        }
        const snapshot = Object.freeze(options.files.value.map(file => Object.freeze({...file})));
        phase.value = pendingCombinedResult.value ? 'opening' : 'combining';
        abortController = new AbortController();
        combineError.value = null;
        combineFailure.value = null;
        combineErrorIsExpected.value = false;
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
                outputName: buildOutputName(snapshot),
                openErrorMessage: options.translate('errors.file.open'),
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
            const opened = options.openResult ? await options.openResult(result) : true;
            if (!opened) throw new Error('ERR_COMBINE_RESULT_OPEN_FAILED');
            if (!options.openResult) options.emitOpenResult(result);
            // The opened document now owns the working copy.
            releaseDocumentOpenWorkingCopyRetention(result);
            pendingCombinedResult.value = null;
            options.files.value = removeCompletedCombineSnapshot(options.files.value, snapshot);
            progress.value = null;
        } catch (error) {
            const failedPhase = phase.value;
            progress.value = null;
            const expected = error instanceof CombinePdfError && [
                'canceled',
                'invalid-input',
                'limit',
                'unsupported',
            ].includes(error.code);
            combineFailure.value = expected
                ? null
                : error instanceof CombinePdfError && error.failure
                    ? error.failure
                    : BrowserLogger.error('pdf-combine', 'PDF combine controller failed', error, {code: 'RENDERER_PDF_COMBINE_OPERATION_FAILED'});
            combineErrorIsExpected.value = expected;
            combineError.value = error instanceof CombinePdfError && error.code === 'canceled'
                ? null
                : error instanceof CombinePdfError && [
                    'invalid-input',
                    'limit',
                    'unsupported',
                ].includes(error.code)
                    ? options.translate('errors.file.invalid')
                    : options.translate(failedPhase === 'opening' ? 'errors.file.open' : 'combinePdf.combineFailed');
        } finally {
            abortController = null;
            phase.value = 'idle';
        }
    }

    function cancel() {
        abortController?.abort(new DOMException('PDF combine was canceled.', 'AbortError'));
    }

    async function savePendingAs() {
        const pending = pendingCombinedResult.value;
        if (!pending || pending.kind !== 'pdf' || !pending.workingPath || isCombining.value) {
            return;
        }
        try {
            const savedPath = await getDocumentFilesCapability().savePdfAs(pending.workingPath, undefined);
            if (savedPath) {
                combineError.value = null;
                combineFailure.value = null;
                combineErrorIsExpected.value = false;
                releasePendingResult();
                progress.value = null;
            }
        } catch (error) {
            combineError.value = options.translate('errors.file.save');
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
        if (!pending || pending.kind !== 'pdf' || !pending.workingPath) {
            return;
        }
        releaseDocumentOpenWorkingCopyRetention(pending);
        void getDocumentWorkingCopyCapability().cleanupFile(pending.workingPath).catch((error: unknown) => {
            BrowserLogger.warn('pdf-combine', 'Failed to remove a released combined PDF', {error});
        });
    }

    function discardPendingResult() {
        releasePendingResult();
        progress.value = null;
        combineError.value = null;
        combineFailure.value = null;
        combineErrorIsExpected.value = false;
    }

    onScopeDispose(() => {
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
        queueMutationLocked,
        canCancel,
        combine,
        cancel,
        savePendingAs,
        discardPendingResult,
    };
};
