import {
    h,
    type VNode,
} from 'vue';
import AppFailureToastDescription from '@app/components/AppFailureToastDescription.vue';
import type {IPresentedFailureCapture} from '@app/utils/failureReporter';
import {
    isFailureSeverity,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { isRecord } from '@contracts/runtimeGuards';
import { isEpochMs } from '@contracts/timestamps';
import type {TTranslateFn} from '@i18n-app';

export interface IFailureToastAction {
    label: string;
    color?: 'neutral' | 'primary';
    variant?: 'outline' | 'soft';
    icon?: string;
    onClick: () => void;
    onMousedown?: (event: MouseEvent) => void;
}

export interface IFailurePresentation extends IPresentedFailureCapture {
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
export interface INoticePresentation extends Pick<IToastOptions, 'id' | 'title' | 'description' | 'actions' | 'duration' | 'progress'> {
    tone: 'warning' | 'info' | 'success';
    onDismiss?: () => void;
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
    'onUpdate:open'?: (open: boolean) => void;
}

export interface IFailureToastTarget {
    add: (options: IToastOptions) => unknown;
    update?: (id: string | number, options: Partial<IToastOptions>) => void;
}

const FAILURE_ERROR_ID_SHORT_LENGTH = 8;
// A failure carries an action and an Error ID, so it stays longer than the
// library's five seconds; hovering the stack pauses it either way.
const FAILURE_TOAST_DURATION_MS = 10_000;
const TOAST_ICONS = {
    error: 'i-ph-warning-circle',
    warning: 'i-ph-warning',
    info: 'i-ph-info',
    success: 'i-ph-check-circle',
} as const satisfies Record<TToastTone, string>;

export function getFailureErrorId(receipt: FailureReceipt) {
    return receipt.eventId.slice(0, FAILURE_ERROR_ID_SHORT_LENGTH);
}

export function getNonEmptyDetails(values: Array<string | undefined>) {
    return values.filter(line => line !== undefined && line.trim().length > 0).join('\n');
}

export function formatFailurePresentationDescription(presentation: IFailurePresentation, t: TTranslateFn) {
    return getNonEmptyDetails([
        presentation.description,
        `${t('errors.runtime.errorId')}: ${getFailureErrorId(presentation.failure)}`,
    ]);
}

export function formatFailurePresentationCopy(presentation: IFailurePresentation) {
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

function isFailureReceiptShape(value: unknown): value is FailureReceipt {
    return isRecord(value)
        && typeof value.eventId === 'string'
        && value.eventId.length > 0
        && typeof value.code === 'string'
        && value.code.length > 0
        && isEpochMs(value.occurredAt)
        && isFailureSeverity(value.severity);
}

export function isFailurePresentation(value: unknown): value is IFailurePresentation {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.title !== 'string') {
        return false;
    }
    if (value.description !== undefined && typeof value.description !== 'string') {
        return false;
    }
    if (value.technicalDetails !== undefined && typeof value.technicalDetails !== 'string') {
        return false;
    }
    if (value.persistent !== undefined && typeof value.persistent !== 'boolean') {
        return false;
    }
    return isFailureReceiptShape(value.failure);
}

export async function copyFailurePresentation(presentation: IFailurePresentation) {
    return copyTextToClipboard(formatFailurePresentationCopy(presentation));
}

export function createFailureToastPresenter(
    toast: IFailureToastTarget,
    // Labels translate each time a toast is presented, rendered or updated, so a
    // presenter created before settings apply the saved locale speaks the current one.
    t: TTranslateFn,
) {
    return function presentFailureToast(presentation: IFailurePresentation) {
        // The receipt names the toast, so a failure that more than one path
        // reports stays one toast; the toaster pulses it instead of stacking.
        const toastId = presentation.failure.eventId;
        const duration = presentation.persistent ? Number.POSITIVE_INFINITY : FAILURE_TOAST_DURATION_MS;
        const actions = (copied: boolean): IFailureToastAction[] => [
            ...(presentation.actions ?? []),
            {
                label: t(copied ? 'errors.runtime.copied' : 'errors.runtime.copy'),
                icon: copied ? 'i-ph-check' : 'i-ph-copy',
                color: 'neutral',
                variant: 'outline',
                onMousedown: event => event.preventDefault(),
                onClick: () => {
                    void copyFailurePresentation(presentation).then((didCopy) => {
                        if (didCopy) {
                            toast.update?.(toastId, {
                                duration,
                                actions: actions(true),
                            });
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
            // The reason reads first; the Error ID is a quiet second line for support.
            description: () => h(AppFailureToastDescription, {
                reason: presentation.description,
                errorIdLabel: t('errors.runtime.errorId'),
                errorId: getFailureErrorId(presentation.failure),
            }),
            actions: actions(false),
            duration,
            ...(presentation.persistent ? {progress: false} : {}),
        });
    };
}

export function createNoticeToastPresenter(toast: IFailureToastTarget) {
    return function presentNoticeToast(notice: INoticePresentation) {
        const {
            tone, onDismiss, ...options
        } = notice;
        toast.add({
            ...options,
            color: tone,
            icon: TOAST_ICONS[tone],
            ...(onDismiss ? {'onUpdate:open': (open: boolean) => open || onDismiss()} : {}),
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
    const presentFailureToast = createFailureToastPresenter(toast, t);
    const presentNoticeToast = createNoticeToastPresenter(toast);

    return {
        presentFailureToast,
        presentNoticeToast,
    };
};
