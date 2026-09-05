import type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationFailureReason,
} from '@app/modules/pdf-viewer/public';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    useFailureToast,
    type FailurePresentation,
} from '@app/composables/useFailureToast';

/**
 * One place where workspace operations that failed become visible.
 *
 * Before issue #91 each site invented its own reporting, so several failure
 * paths reported nothing at all. Callers hand this surface a typed reason; it
 * owns the localized copy and the toast.
 *
 * Only saves keep durable state. A failed save outlives its toast because the
 * status bar has to keep presenting the document as unwritten; a rejected
 * annotation leaves nothing behind to present, so it is told once and dropped
 * rather than parked in a container nothing reads.
 */
type TWorkspaceFailureDomain = 'save' | 'annotation' | 'open';

export type TWorkspaceSaveFailureReason =
    | 'validation-rejected'
    | 'note-persistence-failed'
    | 'capability-unavailable'
    | 'native-save-required'
    | 'persist-rejected'
    | 'document-changed'
    | 'unexpected-error';

type TWorkspaceOpenFailureReason = 'unsupported-encryption';

export const useWorkspaceFailureSurface = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { presentFailureToast } = useFailureToast();
    const hasSaveFailureState = ref(false);
    const saveFailurePresentation = shallowRef<FailurePresentation | null>(null);

    function describeOpenFailure(reason: TWorkspaceOpenFailureReason): string {
        switch (reason) {
            case 'unsupported-encryption':
                return t('errors.file.unsupportedEncryption');
        }
    }

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

    function describeSaveFailure(reason: TWorkspaceSaveFailureReason) {
        switch (reason) {
            case 'validation-rejected':
                return t('errors.save.validation');
            case 'note-persistence-failed':
                return t('errors.save.openNotes');
            case 'document-changed':
                return t('errors.save.documentChanged');
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
        existingReceipt?: FailureReceipt,
    ) {
        if (isDuplicateFailure({
            domain: 'save',
            operationId,
        })) {
            return false;
        }
        const description = detail ?? describeSaveFailure(reason);
        const receipt = existingReceipt ?? BrowserLogger.error(
            'workspace',
            'Workspace save failed',
            {
                operationId,
                reason,
                detail: description,
            },
            {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
        const presentation: FailurePresentation = {
            failure: receipt,
            title: t('errors.file.save'),
            description,
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

    function reportOpenFailure(
        operationId: string,
        reason: TWorkspaceOpenFailureReason,
        detail?: string | null,
    ) {
        const description = detail ?? describeOpenFailure(reason);
        if (isDuplicateFailure({
            domain: 'open',
            operationId,
        })) {
            return false;
        }
        lastReportedOperationIds.set('open', operationId);
        const receipt = BrowserLogger.error(
            'workspace',
            'Workspace open failed',
            {
                operationId,
                reason,
                detail: description,
            },
            {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
        presentFailureToast({
            failure: receipt,
            title: t('errors.file.open'),
            description,
        });
        return true;
    }

    return {
        hasSaveFailure: computed(() => hasSaveFailureState.value),
        saveFailurePresentation,
        getLastFailurePresentation: () => saveFailurePresentation.value,
        clearSaveFailure,
        reportSaveFailure,
        reportAnnotationFailure,
        reportOpenFailure,
    };
};

export type TWorkspaceFailureSurface = ReturnType<typeof useWorkspaceFailureSurface>;
