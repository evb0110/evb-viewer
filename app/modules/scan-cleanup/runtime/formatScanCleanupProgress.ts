import type {TScanCleanupProgress} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';
import {
    type IScanCleanupActivity,
    type IScanCleanupActivityCount,
    resolveScanCleanupActivity,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupActivity';

export const formatScanCleanupActivityCount = (count: IScanCleanupActivityCount, t: TTranslateFn) => (
    count.total === undefined
        ? t('scanCleanup.activity.rechecked', {count: count.completed})
        : t('scanCleanup.runCount', {
            completed: count.completed,
            total: count.total,
        })
);

/** The work left in the current step, as the job itself measured it. */
export const formatScanCleanupEta = (etaSeconds: number, t: TTranslateFn) => (
    etaSeconds >= 60
        ? t('scanCleanup.activity.etaMinutes', {minutes: Math.max(1, Math.ceil(etaSeconds / 60))})
        : t('scanCleanup.activity.etaSeconds', {seconds: Math.max(1, Math.ceil(etaSeconds / 5) * 5)})
);

/** A clock reading such as 0:07 or 1:02:30; digits need no translation. */
export const formatScanCleanupDuration = (durationMs: number) => {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return hours > 0
        ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${String(minutes)}:${seconds}`;
};

/** The widest time text, so the time slot can reserve its box. */
export const resolveScanCleanupTimeWidestText = (t: TTranslateFn) => [
    t('scanCleanup.activity.etaMinutes', {minutes: 999}),
    t('scanCleanup.activity.etaSeconds', {seconds: 55}),
    t('scanCleanup.activity.elapsed', {time: '88:88'}),
].reduce((widest, candidate) => candidate.length > widest.length ? candidate : widest);

export const formatScanCleanupActivityStatus = (activity: IScanCleanupActivity, t: TTranslateFn) => {
    const detail = t(`scanCleanup.activity.detail.${activity.detail}`);
    return activity.count === null
        ? detail
        : t('scanCleanup.runStatus', {
            phase: detail,
            counter: formatScanCleanupActivityCount(activity.count, t),
        });
};

/**
 * One sentence for a run seen from outside the workspace, such as the reader
 * toolbar's scan cleanup button.
 */
export const formatScanCleanupProgress = (
    progress: Pick<TScanCleanupProgress, 'stage' | 'completedUnits' | 'totalUnits'> & Partial<TScanCleanupProgress>,
    t: TTranslateFn,
) => {
    const activity = resolveScanCleanupActivity({
        detection: {
            pending: false,
            progress: null,
            analyzedPages: 0,
            totalPages: 0,
            calibrating: false,
        },
        run: {
            waitingForDetection: false,
            starting: false,
            progress: {
                percent: 0,
                ...progress,
            },
            committing: false,
        },
    })!;
    return {text: formatScanCleanupActivityStatus(activity, t)};
};
