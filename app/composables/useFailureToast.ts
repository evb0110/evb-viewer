import type {IPresentedFailureCapture} from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export interface IFailureToastAction {
    label: string;
    color?: 'neutral' | 'primary';
    variant?: 'outline' | 'soft';
    onClick: () => void;
}

// The public name is pinned by SEN-CORE-06 and intentionally differs from the
// repository's usual interface naming convention during this migration.
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface FailurePresentation extends IPresentedFailureCapture {
    title: string;
    description?: string;
    technicalDetails?: string;
    actions?: IFailureToastAction[];
    /** Stays until dismissed, for failures reported while the user may not be looking. */
    persistent?: boolean;
}

export interface IFailureToastTarget {add: (options: {
    color: 'error';
    title: string;
    description: string;
    actions: IFailureToastAction[];
    duration?: number;
    progress?: boolean;
}) => unknown}

const FAILURE_ERROR_ID_SHORT_LENGTH = 8;

export function getFailureErrorId(receipt: FailureReceipt) {
    return receipt.eventId.slice(0, FAILURE_ERROR_ID_SHORT_LENGTH);
}

export function getNonEmptyDetails(values: Array<string | undefined>) {
    return values.filter((value): value is string => Boolean(value?.trim())).join('\n');
}

export function formatFailurePresentationDescription(presentation: FailurePresentation) {
    return getNonEmptyDetails([
        presentation.description,
        `Error ID: ${getFailureErrorId(presentation.failure)}`,
    ]);
}

export function formatFailurePresentationCopy(presentation: FailurePresentation) {
    return getNonEmptyDetails([
        `Error ID: ${presentation.failure.eventId}`,
        presentation.title,
        presentation.description,
        presentation.technicalDetails,
    ]);
}

export async function copyTextToClipboard(text: string) {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
        return false;
    }

    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

export function isFailurePresentation(value: unknown): value is FailurePresentation {
    return Boolean(
        value
        && typeof value === 'object'
        && 'failure' in value
        && Boolean(value.failure),
    );
}

export async function copyFailurePresentation(presentation: FailurePresentation) {
    return copyTextToClipboard(formatFailurePresentationCopy(presentation));
}

export function createFailureToastPresenter(toast: IFailureToastTarget, copyLabel = 'Copy details') {
    return function presentFailureToast(presentation: FailurePresentation) {
        toast.add({
            color: 'error',
            title: presentation.title,
            description: formatFailurePresentationDescription(presentation),
            actions: presentation.actions ?? [{
                label: copyLabel,
                onClick: () => {
                    void copyFailurePresentation(presentation);
                },
            }],
            ...(presentation.persistent
                ? {
                    duration: Number.POSITIVE_INFINITY,
                    progress: false,
                }
                : {}),
        });
    };
}

export const useFailureToast = () => {
    const toast = useToast();
    const { t } = useTypedI18n();
    const localizedCopyLabel = t('errors.runtime.copy');
    const presentFailureToast = createFailureToastPresenter(
        toast,
        localizedCopyLabel === 'errors.runtime.copy' ? 'Copy details' : localizedCopyLabel,
    );

    return {
        presentFailureToast,
        copyFailurePresentation,
    };
};
