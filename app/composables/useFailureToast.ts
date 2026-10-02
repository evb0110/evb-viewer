import type {VNode} from 'vue';
import type {IPresentedFailureCapture} from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export interface IFailureToastAction {
    label: string;
    color?: 'neutral' | 'primary';
    variant?: 'outline' | 'soft';
    icon?: string;
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

/**
 * An outcome the user has to know about that is not a defect: a file that is
 * gone, input that was skipped, a step that was refused. It has no receipt,
 * so it offers nothing to copy.
 */
export interface INoticePresentation {
    tone: 'warning' | 'info' | 'success';
    title: string;
    description?: string;
    actions?: IFailureToastAction[];
}

type TToastTone = 'error' | INoticePresentation['tone'];

interface IToastOptions {
    id?: string;
    color: TToastTone;
    icon?: string;
    title: string;
    description?: string | (() => VNode);
    actions?: IFailureToastAction[];
    duration?: number;
    progress?: boolean;
    ui?: {root?: string};
}

export interface IFailureToastTarget {
    add: (options: IToastOptions) => unknown;
    update?: (id: string | number, options: Partial<IToastOptions>) => void;
}

interface IFailureToastLabels {
    copy: string;
    copied: string;
    errorId: string;
}

const FAILURE_ERROR_ID_SHORT_LENGTH = 8;
// A failure carries an action and an Error ID, so it stays longer than the
// library's five seconds; hovering the stack pauses it either way.
const FAILURE_TOAST_DURATION_MS = 10_000;
const TOAST_ICONS: Record<TToastTone, string> = {
    error: 'i-ph-warning-circle',
    warning: 'i-ph-warning',
    info: 'i-ph-info',
    success: 'i-ph-check-circle',
};

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

// The reason reads first; the Error ID is a quiet second line for support.
function renderFailureDescription(presentation: FailurePresentation, errorIdLabel: string) {
    return () => h('span', {class: 'app-toast-failure-description'}, [
        presentation.description
            ? h('span', {class: 'app-toast-failure-reason'}, presentation.description)
            : null,
        h('span', {class: 'app-toast-error-id'}, `${errorIdLabel}: ${getFailureErrorId(presentation.failure)}`),
    ]);
}

export function createFailureToastPresenter(
    toast: IFailureToastTarget,
    labels: IFailureToastLabels = {
        copy: 'Copy details',
        copied: 'Copied',
        errorId: 'Error ID',
    },
) {
    return function presentFailureToast(presentation: FailurePresentation) {
        // The receipt names the toast, so a failure that more than one path
        // reports stays one toast; the toaster pulses it instead of stacking.
        const toastId = presentation.failure.eventId;
        // The caller's own actions (Retry, Details) come first; Copy details
        // is always there, and says when it has copied.
        const actions = (copied: boolean): IFailureToastAction[] => [
            ...(presentation.actions ?? []),
            {
                label: copied ? labels.copied : labels.copy,
                icon: copied ? 'i-ph-check' : 'i-ph-copy',
                color: 'neutral',
                variant: 'outline',
                onClick: () => {
                    void copyFailurePresentation(presentation).then((didCopy) => {
                        if (didCopy) {
                            toast.update?.(toastId, {actions: actions(true)});
                        }
                    });
                },
            },
        ];
        toast.add({
            id: toastId,
            color: 'error',
            icon: TOAST_ICONS.error,
            ui: {root: 'app-toast-failure'},
            title: presentation.title,
            description: renderFailureDescription(presentation, labels.errorId),
            actions: actions(false),
            duration: presentation.persistent ? Number.POSITIVE_INFINITY : FAILURE_TOAST_DURATION_MS,
            ...(presentation.persistent ? {progress: false} : {}),
        });
    };
}

export function createNoticeToastPresenter(toast: IFailureToastTarget) {
    return function presentNoticeToast(notice: INoticePresentation) {
        toast.add({
            color: notice.tone,
            icon: TOAST_ICONS[notice.tone],
            title: notice.title,
            ...(notice.description ? {description: notice.description} : {}),
            ...(notice.actions ? {actions: notice.actions} : {}),
        });
    };
}

/**
 * The one way the app tells the user that something did not work: a failure
 * toast with its reason, an Error ID and Copy details, or a notice toast for
 * an expected outcome. Surfaces never insert banners for these; a surface
 * that lost its content shows that in its own box, the way an empty state does.
 */
export const useFailureToast = () => {
    const toast = useToast();
    const { t } = useTypedI18n();
    const presentFailureToast = createFailureToastPresenter(toast, {
        copy: t('errors.runtime.copy'),
        copied: t('errors.runtime.copied'),
        errorId: t('errors.runtime.errorId'),
    });
    const presentNoticeToast = createNoticeToastPresenter(toast);

    return {
        presentFailureToast,
        presentNoticeToast,
        copyFailurePresentation,
    };
};
