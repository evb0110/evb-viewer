import type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationFailureReason,
} from '@app/modules/pdf-viewer/public';
import type { TTranslateFn } from '@i18n-app';
import type {IPdfPersistFailure} from '@app/types/pdfUi';
import {NATIVE_ERROR_ENVELOPE_SCHEMA} from '@contracts/nativeErrors';
import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    getFailureReceipt,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { isPdfjsAssetVersionMismatch } from '@app/utils/isPdfjsAssetVersionMismatch';
import { classifyDocumentOpenError } from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';
import {
    isFailurePresentation,
    copyTextToClipboard,
    getNonEmptyDetails,
    useFailureToast,
    type FailurePresentation,
} from '@app/composables/useFailureToast';

/**
 * One place where workspace operations that failed become visible.
 *
 * Before issue #91 each site invented its own reporting, so several failure
 * paths reported nothing at all. Callers hand this surface a typed reason; it
 * owns the localized copy and the toast. An open's failure is told by the
 * tab's document session instead.
 *
 * Saves keep durable status; rejected note drafts retain their presentation
 * in the existing note owner so Retry and Save preserve the same receipt.
 */
type TWorkspaceFailureDomain = 'save' | 'annotation';

export type TWorkspaceSaveFailureReason =
    | 'validation-rejected'
    | 'note-persistence-failed'
    | 'capability-unavailable'
    | 'native-save-required'
    | 'too-large-for-edit'
    | 'persist-rejected'
    | 'document-changed'
    | 'working-copy-missing'
    | 'unexpected-error';

/**
 * How a document that failed to open or render is described, without telling
 * anyone: the localized reason, the failure's one receipt and its raw cause
 * for Copy details. The document session presents it once.
 */
export function describeDocumentOpenFailure(
    error: unknown,
    t: TTranslateFn,
): FailurePresentation & {description: string} {
    const technicalDetails = getErrorMessage(error).trim();
    return {
        failure: getFailureReceipt(error) ?? BrowserLogger.error('workspace', 'Document failed to open', error, {code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED'}),
        title: t('errors.file.open'),
        description: isPdfjsAssetVersionMismatch(technicalDetails)
            ? t('errors.file.pdfjsAssetMismatch')
            : classifyDocumentOpenError(error, null, t),
        ...(technicalDetails ? {technicalDetails} : {}),
    };
}

export const useWorkspaceFailureSurface = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { presentFailureToast } = useFailureToast();
    const hasSaveFailureState = ref(false);
    const saveFailurePresentation = shallowRef<FailurePresentation | null>(null);

    // Only the operation reported last per domain, so a long session of failed
    // attempts cannot accumulate ids nothing will ever read again.
    const lastReportedOperationIds = new Map<TWorkspaceFailureDomain, string>();

    function isDuplicateFailure(failure: {
        domain: TWorkspaceFailureDomain;
        operationId: string;
    }) {
        if (lastReportedOperationIds.get(failure.domain) === failure.operationId) {
            BrowserLogger.debug('workspace', 'Suppressed duplicate workspace failure toast', {
                domain: failure.domain,
                operationId: failure.operationId,
            });
            return true;
        }
        return false;
    }

    function clearSaveFailure() {
        lastReportedOperationIds.delete('save');
        hasSaveFailureState.value = false;
        saveFailurePresentation.value = null;
    }

    function describeSaveFailure(reason: TWorkspaceSaveFailureReason, persistence?: IPdfPersistFailure) {
        const message = persistence?.message ?? '';
        if (/EACCES|EPERM|permission denied|access (?:is )?denied|os error (?:5|13)/iu.test(message)) {
            return t('errors.save.permissionDenied');
        }
        if (/ENOSPC|EDQUOT|no space left|not enough space|disk (?:is )?full|os error (?:28|112)/iu.test(message)) {
            return t('errors.save.diskFull');
        }
        const nativeError = findSerializableErrorEnvelope(persistence?.cause, NATIVE_ERROR_ENVELOPE_SCHEMA);
        if (nativeError?.code === 'corrupt-xref' || nativeError?.code === 'invalid-request') {
            return t('errors.save.validation');
        }
        if (persistence?.channel === 'native' && reason !== 'validation-rejected') {
            return t(nativeError?.code === 'io' ? 'errors.save.writeFailed' : 'errors.save.nativeFailure');
        }
        switch (reason) {
            case 'validation-rejected':
                return t('errors.save.validation');
            case 'note-persistence-failed':
                return t('errors.save.openNotes');
            case 'document-changed':
                return t('errors.save.documentChanged');
            case 'too-large-for-edit':
                return t('errors.save.tooLargeForEdit');
            case 'working-copy-missing':
                return t('errors.save.workingCopyMissing');
            case 'capability-unavailable':
            case 'native-save-required':
            case 'persist-rejected':
            case 'unexpected-error':
                return t('errors.save.notCompleted');
        }
    }

    function reportSaveFailure(
        operationId: string,
        reason: TWorkspaceSaveFailureReason,
        detail?: string | null,
        existingReceipt?: FailureReceipt | FailurePresentation,
        diagnostics?: IPdfPersistFailure,
    ) {
        if (isDuplicateFailure({
            domain: 'save',
            operationId,
        })) {
            return false;
        }
        const priorPresentation = isFailurePresentation(existingReceipt) ? existingReceipt : undefined;
        const description = detail ?? priorPresentation?.description ?? describeSaveFailure(reason, diagnostics);
        const receipt = priorPresentation?.failure ?? (isFailurePresentation(existingReceipt) ? undefined : existingReceipt) ?? getFailureReceipt(diagnostics?.cause) ?? BrowserLogger.error(
            'workspace',
            'Workspace save failed',
            {
                operationId,
                reason,
                detail: description,
                ...(diagnostics === undefined ? {} : {diagnostics}),
            },
            {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
        );
        const presentation: FailurePresentation = {
            ...priorPresentation,
            failure: receipt,
            title: t('errors.file.save'),
            description,
            ...(diagnostics ? {technicalDetails: getNonEmptyDetails([
                diagnostics.message,
                diagnostics.validation?.errors.join('\n'),
                diagnostics.cause === undefined ? undefined : getErrorMessage(diagnostics.cause),
            ])} : {}),
        };
        lastReportedOperationIds.set('save', operationId);
        saveFailurePresentation.value = presentation;
        // A save that lost its target says nothing about the document now on
        // screen, so it is told once and not kept.
        if (reason !== 'document-changed') {
            hasSaveFailureState.value = true;
        }
        presentFailureToast(presentation);
        return true;
    }

    /**
     * Not every rejected creation deserves a toast. Markup shortcuts fire on
     * every pointer release, and an annotation whose editor is still resolving
     * is not a user problem, so those reasons stay silent. Returning `null`
     * marks a reason as silent; a returned object may still carry no extra
     * detail beyond the shared title.
     */
    function describeAnnotationFailure(
        reason: TAnnotationCreationFailureReason,
    ): {description: string | null} | null {
        switch (reason) {
            case 'selection-spans-pages':
                return {description: t('errors.annotation.selectionSpansPages')};
            case 'mode-switch-failed':
            case 'editor-binding-failed':
            case 'projection-failed':
            case 'point-outside-page':
            case 'page-not-rendered':
            case 'viewer-not-ready':
                return {description: null};
            case 'no-selection':
            case 'selection-not-in-text-layer':
            case 'editor-unavailable':
                return null;
        }
    }

    function reportAnnotationFailure(failure: IAnnotationCreationFailureReport) {
        const described = describeAnnotationFailure(failure.reason);
        if (!described) {
            BrowserLogger.debug('annotations', 'Annotation creation failure is not user-visible', failure);
            return false;
        }
        if (isDuplicateFailure({
            domain: 'annotation',
            operationId: failure.operationId,
        })) {
            return false;
        }
        lastReportedOperationIds.set('annotation', failure.operationId);
        if (failure.kind === 'expected') {
            BrowserLogger.warn('annotations', 'Annotation creation ended with an expected outcome', failure.outcome);
            toast.add({
                color: 'warning',
                title: t('errors.annotation.create'),
                ...(described.description ? {description: described.description} : {}),
            });
            return true;
        }
        presentFailureToast({
            failure: failure.failure,
            title: t('errors.annotation.create'),
            ...(described.description ? {description: described.description} : {}),
        });
        return true;
    }

    function reportNoteFailure(input: {
        cause?: unknown;
        message?: string;
        retry?: () => void;
        previous?: FailurePresentation;
    }): FailurePresentation {
        const reason = (input.cause === undefined ? input.message ?? '' : getErrorMessage(input.cause)).trim() || t('errors.annotation.noteUpdateRejected');
        const presentation: FailurePresentation = {
            failure: getFailureReceipt(input.cause) ?? input.previous?.failure ?? BrowserLogger.error(
                'annotations', 'Annotation note operation failed', input.cause ?? reason,
                {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
            ),
            title: (input.message ?? '').trim() || t('errors.annotation.updateNote'),
            description: t('errors.annotation.noteDraftRetained', {reason}),
            technicalDetails: reason,
            ...(input.retry ? {actions: [{
                label: t('common.retry'),
                onClick: input.retry,
            }]} : {}),
        };
        presentFailureToast(presentation);
        return presentation;
    }

    function presentCopyFeedback(copied: boolean) {
        toast.add({
            color: copied ? 'success' : 'error',
            title: copied
                ? t('errors.file.pdfjsAssetRepairCopied')
                : t('errors.file.pdfjsAssetRepairCopyFailed'),
        });
    }

    /** A failed load's description, with the repair command when PDF.js assets do not match. */
    function describeOpenFailure(error: unknown) {
        const presentation = describeDocumentOpenFailure(error, t);
        if (!isPdfjsAssetVersionMismatch(presentation.technicalDetails ?? '')) {
            return presentation;
        }
        return {
            ...presentation,
            actions: [{
                label: t('errors.file.pdfjsAssetRepairAction'),
                onClick: () => {
                    void copyTextToClipboard('pnpm install --frozen-lockfile').then(presentCopyFeedback);
                },
            }],
        };
    }

    return {
        hasSaveFailure: computed(() => hasSaveFailureState.value),
        saveFailurePresentation,
        getLastFailurePresentation: () => saveFailurePresentation.value,
        clearSaveFailure,
        reportSaveFailure,
        reportAnnotationFailure,
        reportNoteFailure,
        describeOpenFailure,
    };
};

export type TWorkspaceFailureSurface = ReturnType<typeof useWorkspaceFailureSurface>;
