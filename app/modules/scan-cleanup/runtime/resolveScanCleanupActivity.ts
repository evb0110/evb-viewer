import type {
    TScanCleanupProgress,
    TScanCleanupProgressStage,
} from '@contracts/scan-cleanup/electronApiScanCleanup';

/**
 * One user-facing account of everything scan cleanup does for a document:
 * the background analysis the workspace starts on its own and the cleanup run
 * the user starts. Both jobs publish internal stages; this module is the only
 * place that maps them onto the phases and steps the toolbar and its details
 * list show, so the header never changes shape when a run takes over from
 * analysis and every internal stage has a named row.
 */
export const SCAN_CLEANUP_ACTIVITY_PHASES = [
    'analyze',
    'clean',
    'finish',
] as const;
export type TScanCleanupActivityPhase = typeof SCAN_CLEANUP_ACTIVITY_PHASES[number];

export const SCAN_CLEANUP_ACTIVITY_STEPS = [
    {
        id: 'read',
        phase: 'analyze',
    },
    {
        id: 'detect',
        phase: 'analyze',
    },
    {
        id: 'compare',
        phase: 'analyze',
    },
    {
        id: 'prepare',
        phase: 'clean',
    },
    {
        id: 'clean',
        phase: 'clean',
    },
    {
        id: 'build',
        phase: 'finish',
    },
    {
        id: 'open',
        phase: 'finish',
    },
] as const satisfies ReadonlyArray<{
    id: string;
    phase: TScanCleanupActivityPhase
}>;
export type TScanCleanupActivityStep = typeof SCAN_CLEANUP_ACTIVITY_STEPS[number]['id'];
export type TScanCleanupActivityStepState = 'done' | 'active' | 'waiting';

/**
 * The sentence for what is happening right now. Analysis has its own
 * activities; a run reports its job stage directly.
 */
export type TScanCleanupActivityDetail =
    | 'queued'
    | 'read'
    | 'detect'
    | 'compare'
    | 'calibrate'
    | 'starting'
    | Exclude<TScanCleanupProgressStage, 'queued' | 'detecting'>;

export interface IScanCleanupActivityCount {
    completed: number;
    /** Absent when the work has no known size, such as pages re-checked. */
    total?: number;
}

export interface IScanCleanupActivityStepView {
    id: TScanCleanupActivityStep;
    phase: TScanCleanupActivityPhase;
    state: TScanCleanupActivityStepState;
    count?: IScanCleanupActivityCount;
}

export interface IScanCleanupActivity {
    /** A cleanup run is engaged, including while it waits for analysis. */
    run: boolean;
    phase: TScanCleanupActivityPhase;
    step: TScanCleanupActivityStep;
    detail: TScanCleanupActivityDetail;
    /** The phase's own count: pages analyzed, then pages cleaned. */
    count: IScanCleanupActivityCount | null;
    /** Fill of the current phase, 0-1; null when nothing is measurable yet. */
    fraction: number | null;
    /** Work ahead of the fill, such as page images read but not analyzed. */
    bufferFraction: number;
    etaSeconds?: number;
    steps: IScanCleanupActivityStepView[];
}

export interface IScanCleanupDetectionActivityInput {
    /** Analysis work is outstanding, including start-up and calibration. */
    pending: boolean;
    progress: TScanCleanupProgress | null;
    /** Pages with a layout verdict. */
    analyzedPages: number;
    totalPages: number;
    /** Every page has a verdict and ink placement is being calibrated. */
    calibrating: boolean;
}

export interface IScanCleanupRunActivityInput {
    waitingForDetection: boolean;
    /** The click has been accepted and the job is being requested. */
    starting: boolean;
    progress: TScanCleanupProgress | null;
    /** The job has produced its PDF and is committing it. */
    committing: boolean;
}

const PREPARE_STAGES: ReadonlySet<TScanCleanupProgressStage> = new Set([
    'normalizing',
    'probing',
    'extracting',
]);
const CLEAN_STAGES: ReadonlySet<TScanCleanupProgressStage> = new Set([
    'rasterizing',
    'classifying',
    'rendering',
    'detecting',
]);
const BUILD_STAGES: ReadonlySet<TScanCleanupProgressStage> = new Set([
    'collecting',
    'assembling',
]);

function clampUnits(value: number | undefined, total: number) {
    return Math.min(total, Math.max(0, Math.trunc(value ?? 0)));
}

function stepViews(
    states: Readonly<Record<TScanCleanupActivityStep, TScanCleanupActivityStepState>>,
    counts: Readonly<Partial<Record<TScanCleanupActivityStep, IScanCleanupActivityCount>>>,
): IScanCleanupActivityStepView[] {
    return SCAN_CLEANUP_ACTIVITY_STEPS.map(step => ({
        id: step.id,
        phase: step.phase,
        state: states[step.id],
        ...(counts[step.id] === undefined ? {} : {count: counts[step.id]}),
    }));
}

function resolveAnalysis(
    detection: IScanCleanupDetectionActivityInput,
    run: boolean,
): IScanCleanupActivity {
    const progress = detection.progress;
    // The job's own page count is authoritative once it has reported; the
    // viewer's count covers the queued moment before it.
    const total = Math.max(1, Math.trunc(progress !== null && progress.totalUnits > 0
        ? progress.totalUnits
        : detection.totalPages));
    const analyzed = clampUnits(detection.analyzedPages, total);
    // A page is read before it is analyzed, so the read count never trails
    // the verdicts even when a frame reports only one of them.
    const read = Math.max(
        analyzed,
        clampUnits(progress?.rasterizedUnits, total),
        progress?.stage === 'rasterizing' ? clampUnits(progress.completedUnits, total) : 0,
    );
    const rechecked = Math.max(0, Math.trunc(progress?.recheckedUnits ?? 0));
    const verdictsComplete = analyzed >= total;
    const queued = progress === null || progress.stage === 'queued';
    // Reading and analysis overlap once the first verdicts land. The sentence
    // then names the work the count measures and stays put; reading ahead
    // shows as the buffer behind the fill and in its own step row, instead of
    // the sentence flipping every time a batch of page images starts.
    const detail: TScanCleanupActivityDetail = queued
        ? 'queued'
        : verdictsComplete
            ? detection.calibrating ? 'calibrate' : 'compare'
            : analyzed === 0 ? 'read' : 'detect';
    const step: TScanCleanupActivityStep = detail === 'queued' || detail === 'read'
        ? 'read'
        : detail === 'detect' ? 'detect' : 'compare';
    return {
        run,
        phase: 'analyze',
        step,
        detail,
        count: {
            completed: analyzed,
            total,
        },
        fraction: analyzed === 0 && read === 0 ? null : analyzed / total,
        bufferFraction: read / total,
        ...(progress?.etaSeconds === undefined || verdictsComplete ? {} : {etaSeconds: progress.etaSeconds}),
        steps: stepViews({
            read: read >= total || verdictsComplete ? 'done' : queued ? 'waiting' : 'active',
            detect: verdictsComplete ? 'done' : analyzed > 0 || read > 0 ? 'active' : 'waiting',
            compare: verdictsComplete ? 'active' : 'waiting',
            prepare: 'waiting',
            clean: 'waiting',
            build: 'waiting',
            open: 'waiting',
        }, {
            read: {
                completed: read,
                total,
            },
            detect: {
                completed: analyzed,
                total,
            },
            ...(rechecked > 0 ? {compare: {completed: rechecked}} : {}),
        }),
    };
}

function resolveRun(run: IScanCleanupRunActivityInput): IScanCleanupActivity {
    const progress = run.progress;
    const stage = progress?.stage ?? 'queued';
    const counted = progress !== null && progress.totalUnits > 1;
    const count = counted
        ? {
            completed: clampUnits(progress.completedUnits, progress.totalUnits),
            total: progress.totalUnits,
        }
        : undefined;
    const step: TScanCleanupActivityStep = run.committing || stage === 'handoff'
        ? 'open'
        : BUILD_STAGES.has(stage)
            ? 'build'
            : CLEAN_STAGES.has(stage) ? 'clean' : 'prepare';
    const phase = SCAN_CLEANUP_ACTIVITY_STEPS.find(candidate => candidate.id === step)!.phase;
    const stepIndex = SCAN_CLEANUP_ACTIVITY_STEPS.findIndex(candidate => candidate.id === step);
    const detail: TScanCleanupActivityDetail = run.committing
        ? 'handoff'
        : run.starting || progress === null || stage === 'queued'
            ? 'starting'
            : stage === 'detecting' ? 'rendering' : stage;
    const states = Object.fromEntries(SCAN_CLEANUP_ACTIVITY_STEPS.map((candidate, index) => [
        candidate.id,
        index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'waiting',
    ])) as Record<TScanCleanupActivityStep, TScanCleanupActivityStepState>;
    // Cleaning is almost all of a run, so the job's weighted percentage is an
    // honest fill for it; the short finishing tail counts PDF objects rather
    // than pages and has no fill of its own.
    const fraction = phase === 'clean' && progress !== null && progress.percent > 0
        ? Math.min(1, progress.percent / 100)
        : null;
    return {
        run: true,
        phase,
        step,
        detail,
        count: step === 'clean' && count !== undefined ? count : null,
        fraction,
        bufferFraction: 0,
        ...(progress?.etaSeconds === undefined || step !== 'clean' ? {} : {etaSeconds: progress.etaSeconds}),
        steps: stepViews(states, {
            ...(PREPARE_STAGES.has(stage) && count !== undefined ? {prepare: count} : {}),
            ...(step === 'clean' && count !== undefined ? {clean: count} : {}),
        }),
    };
}

/**
 * Resolves what scan cleanup is doing for the document, or null when nothing
 * runs. A run that waits for analysis reports the analysis, so clicking Clean
 * up during analysis continues the same account instead of replacing it.
 */
export function resolveScanCleanupActivity(input: {
    detection: IScanCleanupDetectionActivityInput;
    run: IScanCleanupRunActivityInput | null;
}): IScanCleanupActivity | null {
    if (input.run !== null) {
        return input.run.waitingForDetection
            ? resolveAnalysis(input.detection, true)
            : resolveRun(input.run);
    }
    return input.detection.pending ? resolveAnalysis(input.detection, false) : null;
}
