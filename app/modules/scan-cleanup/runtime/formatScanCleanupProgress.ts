import type {TScanCleanupProgressStage} from '@contracts/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';

interface IScanCleanupProgressCounts {
    stage: TScanCleanupProgressStage;
    completedUnits: number;
    totalUnits: number;
}

interface IScanCleanupPageProgressCounts {
    completedUnits: number;
    totalUnits: number;
}

const COUNTED_STAGES: ReadonlySet<TScanCleanupProgressStage> = new Set([
    'rasterizing',
    'classifying',
    'rendering',
    'detecting',
]);
const ETA_STAGES: ReadonlySet<TScanCleanupProgressStage> = new Set([
    'rasterizing',
    'classifying',
    'rendering',
    'detecting',
]);

const USER_FACING_STAGE: Readonly<Partial<Record<
    TScanCleanupProgressStage,
    TScanCleanupProgressStage
>>> = {
    probing: 'normalizing',
    extracting: 'normalizing',
    collecting: 'assembling',
};

export const formatScanCleanupEta = (
    etaSeconds: number | undefined,
    t: TTranslateFn,
    stage?: TScanCleanupProgressStage,
) => {
    if (etaSeconds === undefined || stage !== undefined && !ETA_STAGES.has(stage)) {
        return t('scanCleanup.etaPending');
    }
    return etaSeconds >= 60
        ? t('scanCleanup.etaMinutes', {minutes: Math.max(1, Math.ceil(etaSeconds / 60))})
        : t('scanCleanup.etaSeconds', {seconds: Math.max(1, Math.ceil(etaSeconds))});
};

export const resolveScanCleanupEtaWidestText = (t: TTranslateFn) => [
    t('scanCleanup.etaPending'),
    t('scanCleanup.etaMinutes', {minutes: 999}),
    t('scanCleanup.etaSeconds', {seconds: 999}),
    t('scanCleanup.finishingPhase'),
    t('scanCleanup.almostDone'),
    t('scanCleanup.detectAll.reconciling'),
].reduce((widest, candidate) => candidate.length > widest.length ? candidate : widest);

export const formatScanCleanupProgress = (progress: IScanCleanupProgressCounts, t: TTranslateFn) => {
    const phase = t(`scanCleanup.runProgress.${USER_FACING_STAGE[progress.stage] ?? progress.stage}`);
    const count = COUNTED_STAGES.has(progress.stage) && progress.totalUnits > 1
        ? t('scanCleanup.runCount', {
            completed: progress.completedUnits,
            total: progress.totalUnits,
        })
        : '';
    return {
        phase,
        count,
        text: count === '' ? phase : t('scanCleanup.runStatus', {
            phase,
            counter: count,
        }),
    };
};

export const formatScanCleanupPreAnalysisProgress = (
    progress: IScanCleanupPageProgressCounts,
    t: TTranslateFn,
) => {
    const phase = t('scanCleanup.detectAll.preAnalyzing');
    const count = t('scanCleanup.runCount', {
        completed: progress.completedUnits,
        total: progress.totalUnits,
    });
    return {
        phase,
        count,
        text: t('scanCleanup.runStatus', {
            phase,
            counter: count,
        }),
    };
};
